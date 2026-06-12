/**
 * SubagentScheduler — the single dispatch point for child runs.
 *
 * Every code path that starts or restarts a child thread (spawn_agent,
 * send_input restarts, team members, rate-limit retries) submits a
 * DispatchRequest here; nothing calls the thread runner directly
 * (design doc §4). Responsibilities:
 *
 * - admission queueing with a global active cap and per-category caps,
 *   released eligibility-FIFO (a blocked queue head never starves entries of
 *   other categories, §4.3);
 * - launch-rate throttling: an initial burst starts immediately, further
 *   launches are spaced out — this throttles launch *rate*, not concurrency;
 * - queued-entry cancellation: aborting a queued entry removes it atomically
 *   and never consumes a slot (§4.4);
 * - rate-limit retry: a run that reports `rate_limited` keeps its agent
 *   instance, re-enters the queue after a backoff honoring retryAfterMs, and
 *   the scheduler is the only 429 backoff layer (§4.5);
 * - AIMD capacity: each 429 shrinks effective global capacity by 1 (min 1, at
 *   most once per window), a quiet period grows it back (§4.5).
 */

export type SubagentRunOutcome =
  | { kind: "final" }
  | { kind: "rate_limited"; retryAfterMs?: number };

export interface DispatchRequest {
  agentId: string;
  category?: string;
  /** Composed abort signal (parent ∪ child controller ∪ budget). */
  signal?: AbortSignal;
  /** Runs the child thread. attempt is 1-based; >1 means rate-limit re-entry. */
  run: (ctx: { attempt: number }) => Promise<SubagentRunOutcome>;
  /** Finalize the record when the entry is aborted while still queued. */
  onCancelledWhileQueued: (reason: unknown) => void;
  /** Finalize the record when rate-limit retries are exhausted. */
  onRateLimitExhausted: (attempts: number) => void;
}

export interface SubagentSchedulerOptions {
  maxActiveSubagents?: number;
  /** Per-category concurrency limits; undefined means no category cap. */
  getCategoryLimit?: (category: string) => number | undefined;
  /** Number of immediate launches before rate spacing applies. Default 4. */
  launchBurst?: number;
  /** Minimum spacing between launches beyond the burst. Default 500ms (0 under NODE_ENV=test). */
  launchIntervalMs?: number;
  rateLimitMaxAttempts?: number;
  /** Backoff per attempt when the provider gave no retry-after. Default 3s/6s/12s (0 under NODE_ENV=test). */
  rateLimitBackoffMs?: number[];
  /** AIMD: minimum spacing between capacity decreases. Default 2s. */
  aimdDecreaseIntervalMs?: number;
  /** AIMD: quiet period after which capacity grows by 1. Default 3min. */
  aimdIncreaseAfterMs?: number;
  now?: () => number;
}

interface QueueEntry {
  request: DispatchRequest;
  attempt: number;
  /** Earliest time this entry may launch (rate-limit backoff). */
  notBefore: number;
  resolve: () => void;
  removeAbortListener?: () => void;
}

const TEST_ENV = process.env.NODE_ENV === "test";

export class SubagentScheduler {
  private readonly queue: QueueEntry[] = [];
  private readonly activeIds = new Set<string>();
  private readonly activeByCategory = new Map<string, number>();

  private readonly maxActive: number;
  private readonly getCategoryLimit: (category: string) => number | undefined;
  private readonly launchBurst: number;
  private readonly launchIntervalMs: number;
  private readonly rateLimitMaxAttempts: number;
  private readonly rateLimitBackoffMs: number[];
  private readonly aimdDecreaseIntervalMs: number;
  private readonly aimdIncreaseAfterMs: number;
  private readonly now: () => number;

  private burstRemaining: number;
  private nextLaunchAt = 0;
  private aimdCapacity: number | null = null;
  private lastCapacityDecreaseAt = 0;
  private lastRateLimitAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SubagentSchedulerOptions = {}) {
    this.maxActive = Math.max(1, options.maxActiveSubagents ?? 8);
    this.getCategoryLimit = options.getCategoryLimit ?? (() => undefined);
    this.launchBurst = Math.max(1, options.launchBurst ?? 4);
    this.launchIntervalMs = options.launchIntervalMs ?? (TEST_ENV ? 0 : 500);
    this.rateLimitMaxAttempts = Math.max(1, options.rateLimitMaxAttempts ?? 3);
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? (TEST_ENV ? [0, 0, 0] : [3_000, 6_000, 12_000]);
    this.aimdDecreaseIntervalMs = options.aimdDecreaseIntervalMs ?? 2_000;
    this.aimdIncreaseAfterMs = options.aimdIncreaseAfterMs ?? 180_000;
    this.now = options.now ?? Date.now;
    this.burstRemaining = this.launchBurst;
  }

  /** Resolves when the child run reaches a final state (or queue cancellation). */
  dispatch(request: DispatchRequest): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: QueueEntry = {
        request,
        attempt: 0,
        notBefore: 0,
        resolve,
      };
      if (request.signal) {
        if (request.signal.aborted) {
          request.onCancelledWhileQueued(request.signal.reason);
          resolve();
          return;
        }
        const onAbort = () => this.cancelQueuedEntry(entry, request.signal?.reason);
        request.signal.addEventListener("abort", onAbort, { once: true });
        entry.removeAbortListener = () => request.signal?.removeEventListener("abort", onAbort);
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  queuePosition(agentId: string): number | undefined {
    const index = this.queue.findIndex((entry) => entry.request.agentId === agentId);
    return index >= 0 ? index + 1 : undefined;
  }

  activeCount(): number {
    return this.activeIds.size;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  /** Effective global concurrency cap, AIMD-adjusted. */
  effectiveCapacity(): number {
    return this.aimdCapacity !== null ? Math.min(this.aimdCapacity, this.maxActive) : this.maxActive;
  }

  private cancelQueuedEntry(entry: QueueEntry, reason: unknown): void {
    const index = this.queue.indexOf(entry);
    if (index < 0) return; // already launched; the run's own signal handles it
    this.queue.splice(index, 1);
    entry.removeAbortListener?.();
    entry.request.onCancelledWhileQueued(reason);
    entry.resolve();
    this.pump();
  }

  private maybeGrowCapacity(now: number): void {
    if (this.aimdCapacity === null) return;
    if (now - this.lastRateLimitAt < this.aimdIncreaseAfterMs) return;
    this.aimdCapacity += 1;
    this.lastRateLimitAt = now; // next increase needs another quiet window
    if (this.aimdCapacity >= this.maxActive) {
      this.aimdCapacity = null;
    }
  }

  private notifyRateLimited(now: number): void {
    if (this.aimdCapacity === null) {
      this.aimdCapacity = Math.max(1, this.activeIds.size);
      this.lastCapacityDecreaseAt = now;
    } else if (now - this.lastCapacityDecreaseAt >= this.aimdDecreaseIntervalMs) {
      this.aimdCapacity = Math.max(1, this.aimdCapacity - 1);
      this.lastCapacityDecreaseAt = now;
    }
    this.lastRateLimitAt = now;
  }

  private eligible(entry: QueueEntry, now: number): boolean {
    if (entry.notBefore > now) return false;
    if (this.activeIds.size >= this.effectiveCapacity()) return false;
    const category = entry.request.category;
    if (category) {
      const limit = this.getCategoryLimit(category);
      if (limit !== undefined && (this.activeByCategory.get(category) ?? 0) >= limit) {
        return false;
      }
    }
    return true;
  }

  private pump(): void {
    const now = this.now();
    this.maybeGrowCapacity(now);

    while (true) {
      if (this.queue.length === 0) {
        if (this.activeIds.size === 0) {
          this.burstRemaining = this.launchBurst;
        }
        return;
      }
      // Eligibility-FIFO: first entry that satisfies both the global and its
      // category limit launches; a capacity-blocked head does not starve the rest.
      const entry = this.queue.find((candidate) => this.eligible(candidate, now));
      if (!entry) {
        this.scheduleWakeup(now);
        return;
      }
      // Launch-rate throttle (burst, then spacing).
      if (this.burstRemaining > 0) {
        this.burstRemaining -= 1;
      } else if (now >= this.nextLaunchAt) {
        this.nextLaunchAt = now + this.launchIntervalMs;
      } else {
        this.scheduleWakeup(now, this.nextLaunchAt);
        return;
      }
      this.launch(entry);
    }
  }

  private scheduleWakeup(now: number, explicitAt?: number): void {
    const candidates: number[] = [];
    if (explicitAt !== undefined) candidates.push(explicitAt);
    for (const entry of this.queue) {
      if (entry.notBefore > now) candidates.push(entry.notBefore);
    }
    if (this.aimdCapacity !== null) {
      candidates.push(this.lastRateLimitAt + this.aimdIncreaseAfterMs);
    }
    if (candidates.length === 0) return; // a slot release will pump
    const at = Math.min(...candidates);
    const delay = Math.max(1, at - now);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, delay);
    if (typeof this.pumpTimer === "object" && "unref" in this.pumpTimer) {
      this.pumpTimer.unref();
    }
  }

  private launch(entry: QueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    entry.removeAbortListener?.();
    entry.removeAbortListener = undefined;

    const { request } = entry;
    this.activeIds.add(request.agentId);
    if (request.category) {
      this.activeByCategory.set(request.category, (this.activeByCategory.get(request.category) ?? 0) + 1);
    }
    entry.attempt += 1;

    void request
      .run({ attempt: entry.attempt })
      .then((outcome) => this.settle(entry, outcome))
      .catch(() => this.settle(entry, { kind: "final" }))
      .finally(() => {
        // Slot release lives here so every exit path — completion, failure,
        // cancellation, thrown errors, early returns inside the runner —
        // releases exactly once before the next pump.
        this.releaseSlot(request);
        this.pump();
      });
  }

  private releaseSlot(request: DispatchRequest): void {
    this.activeIds.delete(request.agentId);
    if (request.category) {
      const current = this.activeByCategory.get(request.category) ?? 0;
      if (current <= 1) this.activeByCategory.delete(request.category);
      else this.activeByCategory.set(request.category, current - 1);
    }
  }

  private settle(entry: QueueEntry, outcome: SubagentRunOutcome): void {
    if (outcome.kind === "final") {
      entry.resolve();
      return;
    }

    const now = this.now();
    this.notifyRateLimited(now);
    if (entry.attempt >= this.rateLimitMaxAttempts) {
      entry.request.onRateLimitExhausted(entry.attempt);
      entry.resolve();
      return;
    }
    if (entry.request.signal?.aborted) {
      entry.request.onCancelledWhileQueued(entry.request.signal.reason);
      entry.resolve();
      return;
    }
    const backoff = outcome.retryAfterMs
      ?? this.rateLimitBackoffMs[Math.min(entry.attempt - 1, this.rateLimitBackoffMs.length - 1)]
      ?? 0;
    entry.notBefore = now + Math.max(0, backoff);
    if (entry.request.signal) {
      const onAbort = () => this.cancelQueuedEntry(entry, entry.request.signal?.reason);
      entry.request.signal.addEventListener("abort", onAbort, { once: true });
      entry.removeAbortListener = () => entry.request.signal?.removeEventListener("abort", onAbort);
    }
    this.queue.push(entry);
    // Re-entries skip the burst accounting; spacing alone applies.
  }
}

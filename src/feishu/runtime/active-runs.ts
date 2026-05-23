/**
 * Per-scope active-run tracker with preemption.
 *
 * Same scopeKey can have at most one run. Starting a new one aborts the
 * previous one's AbortController and waits (briefly) for it to settle
 * before resolving startOrReplace().
 */

import type { ScopeKey } from "../types.js";

interface RunHandle {
  abortController: AbortController;
  donePromise: Promise<void>;
  startedAt: number;
}

export class ActiveRuns {
  private readonly runs = new Map<ScopeKey, RunHandle>();

  isActive(scopeKey: ScopeKey): boolean {
    return this.runs.has(scopeKey);
  }

  getSignal(scopeKey: ScopeKey): AbortSignal | undefined {
    return this.runs.get(scopeKey)?.abortController.signal;
  }

  /**
   * Register a new run for `scopeKey`. If one was already active, aborts it
   * and awaits its settlement (capped at `waitMs`) before returning the new
   * AbortSignal.
   *
   * Caller is responsible for calling `complete(scopeKey)` (or letting the
   * donePromise resolve) when its work is done.
   */
  async startOrReplace(scopeKey: ScopeKey, waitMs: number = 10_000): Promise<{ signal: AbortSignal; complete: () => void }> {
    const existing = this.runs.get(scopeKey);
    if (existing) {
      existing.abortController.abort();
      // Wait for prior run to finish so we don't double-spend the pool slot.
      await Promise.race([
        existing.donePromise,
        new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
      ]);
    }

    const abortController = new AbortController();
    let resolveDone: () => void;
    const donePromise = new Promise<void>((res) => {
      resolveDone = res;
    });
    const handle: RunHandle = {
      abortController,
      donePromise,
      startedAt: Date.now(),
    };
    this.runs.set(scopeKey, handle);

    const complete = () => {
      const current = this.runs.get(scopeKey);
      if (current === handle) {
        this.runs.delete(scopeKey);
      }
      resolveDone();
    };

    return { signal: abortController.signal, complete };
  }

  /** Abort a single scope's run. Used by /stop and shutdown. */
  abort(scopeKey: ScopeKey): boolean {
    const handle = this.runs.get(scopeKey);
    if (!handle) return false;
    handle.abortController.abort();
    return true;
  }

  /** Abort all active runs. Returns the number aborted. */
  abortAll(): number {
    let count = 0;
    for (const handle of this.runs.values()) {
      handle.abortController.abort();
      count++;
    }
    return count;
  }

  /** Wait for all current runs to settle, capped at `maxWaitMs`. */
  async waitAll(maxWaitMs: number = 10_000): Promise<void> {
    const promises = Array.from(this.runs.values()).map((h) => h.donePromise);
    if (promises.length === 0) return;
    await Promise.race([
      Promise.all(promises),
      new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
    ]);
  }

  size(): number {
    return this.runs.size;
  }
}

import { describe, expect, it } from "vitest";
import { SubagentScheduler, type SubagentRunOutcome } from "../agent/subagent-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function noopCancel() {
  // queued-cancellation not expected in this test
}

describe("SubagentScheduler", () => {
  it("enforces the global active cap and releases slots on completion", async () => {
    const scheduler = new SubagentScheduler({ maxActiveSubagents: 1, launchIntervalMs: 0 });
    const firstGate = deferred();
    let firstStarted = false;
    let secondStarted = false;

    const first = scheduler.dispatch({
      agentId: "a",
      run: async () => {
        firstStarted = true;
        await firstGate.promise;
        return { kind: "final" };
      },
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {},
    });
    const second = scheduler.dispatch({
      agentId: "b",
      run: async () => {
        secondStarted = true;
        return { kind: "final" };
      },
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(false);
    expect(scheduler.queuePosition("b")).toBe(1);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });

  it("enforces per-category limits with eligibility-FIFO (a blocked head does not starve other categories)", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 8,
      launchIntervalMs: 0,
      getCategoryLimit: (category) => (category === "review" ? 1 : undefined),
    });
    const reviewGate = deferred();
    const started: string[] = [];

    const runFor = (id: string, gate?: Promise<void>) => async (): Promise<SubagentRunOutcome> => {
      started.push(id);
      if (gate) await gate;
      return { kind: "final" };
    };

    const a = scheduler.dispatch({
      agentId: "review-1",
      category: "review",
      run: runFor("review-1", reviewGate.promise),
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {},
    });
    const b = scheduler.dispatch({
      agentId: "review-2",
      category: "review",
      run: runFor("review-2"),
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {},
    });
    const c = scheduler.dispatch({
      agentId: "explore-1",
      category: "explore",
      run: runFor("explore-1"),
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // review-2 is queue head but its category is at capacity; explore-1 must not starve.
    expect(started).toContain("review-1");
    expect(started).toContain("explore-1");
    expect(started).not.toContain("review-2");

    reviewGate.resolve();
    await Promise.all([a, b, c]);
    expect(started).toContain("review-2");
  });

  it("cancels a queued entry atomically without consuming a slot", async () => {
    const scheduler = new SubagentScheduler({ maxActiveSubagents: 1, launchIntervalMs: 0 });
    const gate = deferred();
    const controller = new AbortController();
    let cancelledReason: unknown;
    let queuedRunStarted = false;

    const first = scheduler.dispatch({
      agentId: "running",
      run: async () => {
        await gate.promise;
        return { kind: "final" };
      },
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {},
    });
    const second = scheduler.dispatch({
      agentId: "queued",
      signal: controller.signal,
      run: async () => {
        queuedRunStarted = true;
        return { kind: "final" };
      },
      onCancelledWhileQueued: (reason) => {
        cancelledReason = reason;
      },
      onRateLimitExhausted: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("user closed"));
    await second; // resolves promptly without waiting for the running child
    expect(queuedRunStarted).toBe(false);
    expect((cancelledReason as Error).message).toBe("user closed");
    expect(scheduler.queuePosition("queued")).toBeUndefined();

    gate.resolve();
    await first;
  });

  it("re-runs a rate-limited entry with the same attempt counter and exhausts after max attempts", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 2,
      launchIntervalMs: 0,
      rateLimitMaxAttempts: 3,
      rateLimitBackoffMs: [0, 0, 0],
    });
    const attempts: number[] = [];
    let exhaustedAttempts = 0;

    await scheduler.dispatch({
      agentId: "limited",
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return { kind: "rate_limited" };
      },
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: (count) => {
        exhaustedAttempts = count;
      },
    });

    expect(attempts).toEqual([1, 2, 3]);
    expect(exhaustedAttempts).toBe(3);
  });

  it("recovers after rate limits and lets a retry succeed", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 2,
      launchIntervalMs: 0,
      rateLimitBackoffMs: [0, 0, 0],
    });
    const attempts: number[] = [];
    let exhausted = false;

    await scheduler.dispatch({
      agentId: "retry-ok",
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return attempt < 2 ? { kind: "rate_limited" } : { kind: "final" };
      },
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {
        exhausted = true;
      },
    });

    expect(attempts).toEqual([1, 2]);
    expect(exhausted).toBe(false);
  });

  it("shrinks AIMD capacity on rate limits", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 8,
      launchIntervalMs: 0,
      rateLimitMaxAttempts: 1,
      rateLimitBackoffMs: [0],
    });
    expect(scheduler.effectiveCapacity()).toBe(8);

    await scheduler.dispatch({
      agentId: "limited",
      run: async () => ({ kind: "rate_limited" }),
      onCancelledWhileQueued: noopCancel,
      onRateLimitExhausted: () => {},
    });

    expect(scheduler.effectiveCapacity()).toBeLessThan(8);
    expect(scheduler.effectiveCapacity()).toBeGreaterThanOrEqual(1);
  });
});

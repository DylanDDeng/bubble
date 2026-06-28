import { describe, expect, it } from "vitest";
import { SubagentScheduler, type DispatchRequest, type SubagentRunOutcome } from "../agent/subagent-scheduler.js";

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

// Fills the required finalize callbacks so each test only supplies what it asserts.
function req(partial: Partial<DispatchRequest> & Pick<DispatchRequest, "agentId" | "run">): DispatchRequest {
  return {
    onCancelledWhileQueued: noopCancel,
    onRateLimitExhausted: () => {},
    onTransportRetryExhausted: () => {},
    ...partial,
  };
}

describe("SubagentScheduler", () => {
  it("enforces the global active cap and releases slots on completion", async () => {
    const scheduler = new SubagentScheduler({ maxActiveSubagents: 1, launchIntervalMs: 0 });
    const firstGate = deferred();
    let firstStarted = false;
    let secondStarted = false;

    const first = scheduler.dispatch(req({
      agentId: "a",
      run: async () => {
        firstStarted = true;
        await firstGate.promise;
        return { kind: "final" };
      },
    }));
    const second = scheduler.dispatch(req({
      agentId: "b",
      run: async () => {
        secondStarted = true;
        return { kind: "final" };
      },
    }));

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

    const a = scheduler.dispatch(req({
      agentId: "review-1",
      category: "review",
      run: runFor("review-1", reviewGate.promise),
    }));
    const b = scheduler.dispatch(req({
      agentId: "review-2",
      category: "review",
      run: runFor("review-2"),
    }));
    const c = scheduler.dispatch(req({
      agentId: "explore-1",
      category: "explore",
      run: runFor("explore-1"),
    }));

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

    const first = scheduler.dispatch(req({
      agentId: "running",
      run: async () => {
        await gate.promise;
        return { kind: "final" };
      },
    }));
    const second = scheduler.dispatch(req({
      agentId: "queued",
      signal: controller.signal,
      run: async () => {
        queuedRunStarted = true;
        return { kind: "final" };
      },
      onCancelledWhileQueued: (reason) => {
        cancelledReason = reason;
      },
    }));

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

    await scheduler.dispatch(req({
      agentId: "limited",
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return { kind: "rate_limited" };
      },
      onRateLimitExhausted: (count) => {
        exhaustedAttempts = count;
      },
    }));

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

    await scheduler.dispatch(req({
      agentId: "retry-ok",
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return attempt < 2 ? { kind: "rate_limited" } : { kind: "final" };
      },
      onRateLimitExhausted: () => {
        exhausted = true;
      },
    }));

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

    await scheduler.dispatch(req({
      agentId: "limited",
      run: async () => ({ kind: "rate_limited" }),
    }));

    expect(scheduler.effectiveCapacity()).toBeLessThan(8);
    expect(scheduler.effectiveCapacity()).toBeGreaterThanOrEqual(1);
  });

  it("re-runs a transport_retry entry on its own counter and exhausts via onTransportRetryExhausted", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 2,
      launchIntervalMs: 0,
      transportRetryMaxAttempts: 2,
      transportRetryBackoffMs: [0, 0],
    });
    const attempts: number[] = [];
    let transportExhausted = 0;
    let rateLimitExhausted = false;

    await scheduler.dispatch(req({
      agentId: "timeout",
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return { kind: "transport_retry" };
      },
      onRateLimitExhausted: () => {
        rateLimitExhausted = true;
      },
      onTransportRetryExhausted: (count) => {
        transportExhausted = count;
      },
    }));

    // launch attempt counter increments each re-launch (attempt>1 => resumeWithoutInput)
    expect(attempts).toEqual([1, 2]);
    expect(transportExhausted).toBe(2);
    expect(rateLimitExhausted).toBe(false);
  });

  it("recovers after a transient transport error and lets a retry succeed", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 2,
      launchIntervalMs: 0,
      transportRetryMaxAttempts: 3,
      transportRetryBackoffMs: [0, 0, 0],
    });
    const attempts: number[] = [];
    let exhausted = false;

    await scheduler.dispatch(req({
      agentId: "timeout-then-ok",
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return attempt < 2 ? { kind: "transport_retry" } : { kind: "final" };
      },
      onTransportRetryExhausted: () => {
        exhausted = true;
      },
    }));

    expect(attempts).toEqual([1, 2]);
    expect(exhausted).toBe(false);
  });

  it("does NOT shrink AIMD capacity on transport retries (a timeout is not a rate-limit signal)", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 8,
      launchIntervalMs: 0,
      transportRetryMaxAttempts: 1,
      transportRetryBackoffMs: [0],
    });
    expect(scheduler.effectiveCapacity()).toBe(8);

    await scheduler.dispatch(req({
      agentId: "timeout",
      run: async () => ({ kind: "transport_retry" }),
    }));

    expect(scheduler.effectiveCapacity()).toBe(8);
  });

  it("cancels a transport_retry entry aborted during backoff instead of re-launching", async () => {
    const scheduler = new SubagentScheduler({
      maxActiveSubagents: 2,
      launchIntervalMs: 0,
      transportRetryMaxAttempts: 5,
      transportRetryBackoffMs: [50, 50, 50, 50, 50],
    });
    const controller = new AbortController();
    const attempts: number[] = [];
    let cancelledReason: unknown;

    const run = scheduler.dispatch(req({
      agentId: "cancel-during-backoff",
      signal: controller.signal,
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return { kind: "transport_retry" };
      },
      onCancelledWhileQueued: (reason) => {
        cancelledReason = reason;
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("user closed during backoff"));
    await run;

    expect(attempts).toEqual([1]); // re-launch never happened
    expect((cancelledReason as Error).message).toBe("user closed during backoff");
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PendingQueue, combineQueuedMessages } from "../runtime/pending-queue.js";

describe("PendingQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes after debounce window", async () => {
    const flushes: Array<{ scope: string; size: number }> = [];
    const q = new PendingQueue({
      debounceMs: 100,
      onFlush: async (scopeKey, batch) => {
        flushes.push({ scope: scopeKey, size: batch.length });
      },
    });
    q.push("s1", { text: "hi", messageId: "m1", receivedAt: 0 });
    expect(flushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual([{ scope: "s1", size: 1 }]);
  });

  it("coalesces messages within debounce window", async () => {
    const flushes: number[] = [];
    const q = new PendingQueue({
      debounceMs: 100,
      onFlush: async (_scopeKey, batch) => {
        flushes.push(batch.length);
      },
    });
    q.push("s1", { text: "a", messageId: "m1", receivedAt: 0 });
    await vi.advanceTimersByTimeAsync(50);
    q.push("s1", { text: "b", messageId: "m2", receivedAt: 50 });
    await vi.advanceTimersByTimeAsync(50);
    q.push("s1", { text: "c", messageId: "m3", receivedAt: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual([3]);
  });

  it("isolates scopes", async () => {
    const flushes: Array<[string, number]> = [];
    const q = new PendingQueue({
      debounceMs: 50,
      onFlush: async (scope, batch) => { flushes.push([scope, batch.length]); },
    });
    q.push("s1", { text: "a", messageId: "m1", receivedAt: 0 });
    q.push("s2", { text: "b", messageId: "m2", receivedAt: 0 });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes.sort()).toEqual([["s1", 1], ["s2", 1]]);
  });

  it("block suppresses flush; unblock flushes pending", async () => {
    const flushes: number[] = [];
    const q = new PendingQueue({
      debounceMs: 50,
      onFlush: async (_s, batch) => { flushes.push(batch.length); },
    });
    q.block("s1");
    q.push("s1", { text: "a", messageId: "m1", receivedAt: 0 });
    q.push("s1", { text: "b", messageId: "m2", receivedAt: 0 });
    await vi.advanceTimersByTimeAsync(200);
    expect(flushes).toEqual([]);
    q.unblock("s1");
    // unblock triggers an immediate flush (microtask)
    await vi.runAllTimersAsync();
    expect(flushes).toEqual([2]);
  });
});

describe("combineQueuedMessages", () => {
  it("returns the text directly for a single message", () => {
    expect(
      combineQueuedMessages([{ text: "hi", messageId: "m", receivedAt: 0 }]),
    ).toBe("hi");
  });

  it("joins multiple messages with blank lines", () => {
    const joined = combineQueuedMessages([
      { text: "first", messageId: "m1", receivedAt: 0 },
      { text: "second", messageId: "m2", receivedAt: 0 },
    ]);
    expect(joined).toBe("first\n\nsecond");
  });
});

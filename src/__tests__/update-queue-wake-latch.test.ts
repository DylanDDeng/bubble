import { describe, expect, it } from "vitest";
import { createUpdateQueue } from "../agent.js";

/**
 * The tool-execution loop in Agent.run() parks on updateQueue.wait() but is
 * woken from three places (its own push, the tool settling, and background
 * subagent updates). A wake() that fires while the consuming generator is
 * suspended at a yield finds no parked waiter. Today every caller pairs its
 * wake with a synchronously-checked flag so nothing is dropped, but that
 * invariant lives only in a comment — these tests pin the queue-local latch
 * that makes it hold regardless of caller discipline.
 */
describe("createUpdateQueue wake latch", () => {
  it("delivers a wake that fired with no parked waiter", async () => {
    const queue = createUpdateQueue<string>();

    // Nobody is waiting yet — this is the wake that used to be dropped.
    queue.wake();

    // Must resolve immediately rather than hanging until the next wake.
    await expect(queue.wait()).resolves.toBe("woken");
  });

  it("consumes the latch once, then parks again", async () => {
    const queue = createUpdateQueue<string>();
    queue.wake();

    await expect(queue.wait()).resolves.toBe("woken");

    // Latch is spent: the next wait must genuinely park until woken.
    let settled = false;
    const pending = queue.wait().then((status) => {
      settled = true;
      return status;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    queue.wake();
    await expect(pending).resolves.toBe("woken");
  });

  it("does not swallow a wake delivered to a parked waiter", async () => {
    const queue = createUpdateQueue<string>();
    const pending = queue.wait();
    queue.wake();
    await expect(pending).resolves.toBe("woken");

    // The parked-waiter path must not leave the latch set behind it,
    // otherwise the next wait() returns spuriously.
    let settled = false;
    void queue.wait().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("still short-circuits on queued items", async () => {
    const queue = createUpdateQueue<string>();
    queue.push("a");
    await expect(queue.wait()).resolves.toBe("woken");
    expect(queue.drain()).toEqual(["a"]);
  });

  it("reports aborted when the signal is already aborted and no wake is pending", async () => {
    const queue = createUpdateQueue<string>();
    const controller = new AbortController();
    controller.abort();
    await expect(queue.wait(controller.signal)).resolves.toBe("aborted");
  });

  it("prefers a pending wake over an aborted signal", async () => {
    const queue = createUpdateQueue<string>();
    const controller = new AbortController();
    controller.abort();
    queue.wake();
    // A wake that already fired is real work; it must not be lost to abort.
    await expect(queue.wait(controller.signal)).resolves.toBe("woken");
  });
});

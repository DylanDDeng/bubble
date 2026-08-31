import { describe, expect, it, vi } from "vitest";
import { AgentAbortError } from "../../agent.js";
import { SessionTurnCoordinator } from "../session-turn-coordinator.js";

describe("SessionTurnCoordinator", () => {
  it("runs one session FIFO and keeps independent sessions parallel", async () => {
    const coordinator = new SessionTurnCoordinator();
    const first = coordinator.reserve("a");
    const second = coordinator.reserve("a");
    const other = coordinator.reserve("b");

    await first.waitForStart();
    first.markActive();
    await other.waitForStart();
    other.markActive();
    expect(coordinator.getState("a")).toMatchObject({ active: true, queued: 1, phase: "active" });
    expect(coordinator.getState("b")).toMatchObject({ active: true, queued: 0, phase: "active" });

    first.finish();
    expect(second.phase).toBe("reserved");
    await second.waitForStart();
    second.markActive();
    second.finish();
    other.finish();
    expect(coordinator.getState("a")).toEqual({ active: false, queued: 0, phase: "idle" });
  });

  it("stops reserved and queued turns before either iterator starts", async () => {
    const coordinator = new SessionTurnCoordinator();
    const first = coordinator.reserve("a");
    const second = coordinator.reserve("a");

    expect(coordinator.stop("a")).toBe(2);
    await expect(first.waitForStart()).rejects.toThrow("SDK turn stopped");
    await expect(second.waitForStart()).rejects.toThrow("SDK turn stopped");
    await Promise.all([first.completion, second.completion]);
    expect(coordinator.getState("a")).toEqual({ active: false, queued: 0, phase: "idle" });
  });

  it("publishes the promoted reservation atomically at lease handoff", async () => {
    const coordinator = new SessionTurnCoordinator();
    const first = coordinator.reserve("a");
    const promoted = coordinator.reserve("a");
    await first.waitForStart();
    first.markActive();

    first.finish();
    expect(coordinator.getState("a")).toEqual({ active: true, queued: 0, phase: "reserved" });
    expect(coordinator.stop("a", "stopped during handoff")).toBe(1);
    await expect(promoted.waitForStart()).rejects.toThrow("stopped during handoff");
    expect(coordinator.getState("a")).toEqual({ active: false, queued: 0, phase: "idle" });
  });

  it("clears only queued turns", async () => {
    const coordinator = new SessionTurnCoordinator();
    const active = coordinator.reserve("a");
    const queued = coordinator.reserve("a");
    await active.waitForStart();
    active.markActive();

    expect(coordinator.clearQueue("a")).toBe(1);
    await expect(queued.waitForStart()).rejects.toThrow("Queued SDK turn cancelled");
    expect(coordinator.getState("a")).toMatchObject({ active: true, queued: 0 });
    active.finish();
  });

  it("waits for active teardown before completing deletion and leaves a tombstone", async () => {
    const coordinator = new SessionTurnCoordinator();
    const active = coordinator.reserve("a");
    await active.waitForStart();
    active.markActive();

    let deleted = false;
    const deletion = coordinator.delete("a").then(() => {
      deleted = true;
    });
    expect(active.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(deleted).toBe(false);

    active.finish();
    await deletion;
    expect(coordinator.getState("a")).toEqual({ active: false, queued: 0, phase: "deleted" });
    expect(() => coordinator.reserve("a")).toThrow("Session is deleted");
  });

  it("detaches an external AbortSignal listener after normal completion", async () => {
    const coordinator = new SessionTurnCoordinator();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const turn = coordinator.reserve("a", controller.signal);
    await turn.waitForStart();
    turn.markActive();
    turn.finish();
    await turn.completion;

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes an externally aborted waiter without consuming the slot", async () => {
    const coordinator = new SessionTurnCoordinator();
    const active = coordinator.reserve("a");
    const controller = new AbortController();
    const cancelled = coordinator.reserve("a", controller.signal);
    const next = coordinator.reserve("a");

    controller.abort(new AgentAbortError("host cancelled queued turn"));
    await expect(cancelled.waitForStart()).rejects.toThrow("host cancelled queued turn");
    active.finish();
    await next.waitForStart();
    next.finish();
  });
});

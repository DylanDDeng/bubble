/**
 * Unit tests for the pure steer/queue input state machine
 * (controller extraction §2.3, legacy app.tsx:1768-1930 + 2422-2435).
 */
import { describe, expect, it } from "vitest";
import {
  beginSteer,
  createInputQueueState,
  drainLeftoverSteers,
  drainNextQueued,
  enqueue,
  purgeForSessionSwitch,
  reduceInputQueueEvent,
} from "../tui/controller/input-queue-machine.js";

const q = (text: string, extra: Partial<{ displayKey: string; sessionFile: string }> = {}) => ({
  payload: { text, images: [] },
  ...extra,
});

describe("input queue state machine", () => {
  it("begins a steer and reports the pending count", () => {
    const state = createInputQueueState();
    const { effects } = beginSteer(state, { id: "s1", content: "go", displayKey: "msg-1" });
    expect(state.pendingSteers.size).toBe(1);
    expect(effects).toContainEqual({ kind: "queue-updated", pending: 1 });
  });

  it("input_applied removes the steer and moves its row (full reprint under tmux)", () => {
    const state = createInputQueueState();
    beginSteer(state, { id: "s1", content: "go", displayKey: "msg-1" });

    const mux = reduceInputQueueEvent(state, { type: "input_applied", id: "s1", content: "go", target: "current_turn" }, { isMultiplexed: true });
    expect(mux.state.pendingSteers.size).toBe(0);
    expect(mux.effects).toContainEqual({ kind: "transcript-move-message", displayKey: "msg-1", fullReprint: true });

    const state2 = createInputQueueState();
    beginSteer(state2, { id: "s1", content: "go", displayKey: "msg-1" });
    const plain = reduceInputQueueEvent(state2, { type: "input_applied", id: "s1", content: "go", target: "current_turn" }, { isMultiplexed: false });
    expect(plain.effects).toContainEqual({ kind: "transcript-move-message", displayKey: "msg-1", fullReprint: false });
  });

  it("input_rejected requeues the text for the next turn", () => {
    const state = createInputQueueState();
    beginSteer(state, { id: "s1", content: "later", displayKey: "msg-1", sessionFile: "/a.jsonl" });

    const { state: next, effects } = reduceInputQueueEvent(
      state,
      { type: "input_rejected", id: "s1", content: "later", reason: "no_continuation", target: "next_turn" },
      { isMultiplexed: false, runSessionFile: "/a.jsonl" },
    );
    expect(next.pendingSteers.size).toBe(0);
    expect(next.queued).toHaveLength(1);
    expect(next.queued[0]).toMatchObject({
      payload: { text: "later" },
      displayKey: "msg-1",
      sessionFile: "/a.jsonl",
    });
    expect(effects).toContainEqual({ kind: "steer-requeued", id: "s1", displayKey: "msg-1" });
  });

  it("input_pending_changed zero clears all pending steers", () => {
    const state = createInputQueueState();
    beginSteer(state, { id: "s1", content: "a", displayKey: "m1" });
    beginSteer(state, { id: "s2", content: "b", displayKey: "m2" });

    const { state: next, effects } = reduceInputQueueEvent(
      state, { type: "input_pending_changed", pending: 0 }, { isMultiplexed: false },
    );
    expect(next.pendingSteers.size).toBe(0);
    expect(effects).toContainEqual({ kind: "queue-updated", pending: 0 });
  });

  it("non-input events pass through untouched", () => {
    const state = createInputQueueState();
    const { state: same, effects } = reduceInputQueueEvent(state, { type: "turn_start" }, { isMultiplexed: false });
    expect(same).toBe(state);
    expect(effects).toHaveLength(0);
  });

  it("cancelled run drops leftover steers; normal end requeues them", () => {
    const cancelledState = createInputQueueState();
    beginSteer(cancelledState, { id: "s1", content: "x", displayKey: "m1", sessionFile: "/a.jsonl" });
    const { state: afterCancel } = drainLeftoverSteers(cancelledState, [{ id: "s1", content: "x" }], { cancelled: true, runSessionFile: "/a.jsonl" });
    expect(afterCancel.pendingSteers.size).toBe(0);
    expect(afterCancel.queued).toHaveLength(0);

    const normalState = createInputQueueState();
    beginSteer(normalState, { id: "s1", content: "x", displayKey: "m1", sessionFile: "/a.jsonl" });
    const { state: afterNormal } = drainLeftoverSteers(normalState, [{ id: "s1", content: "x" }], { cancelled: false, runSessionFile: "/a.jsonl" });
    expect(afterNormal.queued).toHaveLength(1);
    expect(afterNormal.queued[0]!.payload.text).toBe("x");
  });

  it("drainNextQueued gates on run/submit/overlay and session ownership", () => {
    const state = createInputQueueState();
    enqueue(state, q("first", { sessionFile: "/a.jsonl", displayKey: "m1" }));
    enqueue(state, q("stale", { sessionFile: "/b.jsonl", displayKey: "m2" }));

    const blocked = drainNextQueued(state, { runActive: true, startingSubmit: false, overlayOpen: false });
    expect(blocked.submit).toBeUndefined();

    const overlayBlocked = drainNextQueued(state, { runActive: false, startingSubmit: false, overlayOpen: true });
    expect(overlayBlocked.submit).toBeUndefined();

    const ready = drainNextQueued(state, { runActive: false, startingSubmit: false, overlayOpen: false, currentSessionFile: "/a.jsonl" });
    expect(ready.submit?.payload.text).toBe("first");

    // After draining the owned item, the stale one is skipped, not submitted.
    const next = drainNextQueued(ready.state, { runActive: false, startingSubmit: false, overlayOpen: false, currentSessionFile: "/a.jsonl" });
    expect(next.submit).toBeUndefined();
    expect(next.state.queued).toHaveLength(0);
  });

  it("session switch purges everything", () => {
    const state = createInputQueueState();
    enqueue(state, q("queued"));
    beginSteer(state, { id: "s1", content: "steering", displayKey: "m1" });

    const { state: next, effects } = purgeForSessionSwitch(state);
    expect(next.queued).toHaveLength(0);
    expect(next.pendingSteers.size).toBe(0);
    expect(effects).toContainEqual({ kind: "queue-updated", pending: 0 });
  });
});

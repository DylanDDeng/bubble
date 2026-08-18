/**
 * Pure steer/queue input state machine (controller extraction §2.3).
 *
 * Encodes the lifecycle that app.tsx:1768-1813 and the run-finally block
 * (app.tsx:1888-1930) implement inline:
 *
 *   queued ──(submit while running & steer-eligible)──▶ steering(pending_steer)
 *   steering ──input_applied──▶ applied (row moves to transcript end)
 *   steering ──input_rejected──▶ queued (badge flips, row kept)
 *   steering ──run cancel + leftover──▶ dropped (row deleted)
 *   steering ──run normal end + leftover──▶ queued (requeued)
 *   queued ──drain (gates pass)──▶ submitted (placeholder row removed)
 *   any ──session switch──▶ purged
 *
 * No rendering, no timers, no Ink: state in, (state, effects) out.
 */
import type { AgentEvent } from "../../types.js";
import type { ControllerEffect } from "./effects.js";
import type { PendingSteerMeta, QueuedInput } from "../model/input-queue.js";
export type { PendingSteerMeta, QueuedInput };

export interface InputQueueState {
  queued: QueuedInput[];
  pendingSteers: Map<string, PendingSteerMeta>;
}

export interface QueueDrainGate {
  runActive: boolean;
  startingSubmit: boolean;
  overlayOpen: boolean;
  currentSessionFile?: string;
}

export interface QueueTransition {
  readonly state: InputQueueState;
  readonly effects: readonly ControllerEffect[];
}

export function createInputQueueState(): InputQueueState {
  return { queued: [], pendingSteers: new Map() };
}

/** Submit while a run is active and the input is steer-eligible. */
export function beginSteer(
  state: InputQueueState,
  input: { id: string; content: string; displayKey: string; sessionFile?: string },
): QueueTransition {
  state.pendingSteers.set(input.id, { displayKey: input.displayKey, sessionFile: input.sessionFile });
  return {
    state,
    effects: [{ kind: "queue-updated", pending: state.pendingSteers.size }],
  };
}

/** Queue an input for the next turn (Tab or steer-ineligible while running). */
export function enqueue(
  state: InputQueueState,
  input: QueuedInput,
): QueueTransition {
  state.queued.push(input);
  return {
    state,
    effects: [{ kind: "queue-updated", pending: state.pendingSteers.size }],
  };
}

/** Reduce an agent event against the queue state (input_* events only). */
export function reduceInputQueueEvent(
  state: InputQueueState,
  event: AgentEvent,
  ctx: { isMultiplexed: boolean; runSessionFile?: string },
): QueueTransition {
  switch (event.type) {
    case "input_applied": {
      const steer = state.pendingSteers.get(event.id);
      if (!steer) return { state, effects: [] };
      state.pendingSteers.delete(event.id);
      // app.tsx:1768-1789 — moving the steer out of the live region is an
      // append off a multiplexer but needs a full reprint under tmux/screen.
      return {
        state,
        effects: [
          { kind: "transcript-move-message", displayKey: steer.displayKey, fullReprint: ctx.isMultiplexed },
          { kind: "queue-updated", pending: state.pendingSteers.size },
        ],
      };
    }
    case "input_rejected": {
      // app.tsx:1791-1806 — no continuation left: badge flips to QUEUED and
      // the text is queued for the next turn.
      const steer = state.pendingSteers.get(event.id);
      if (!steer) return { state, effects: [] };
      state.pendingSteers.delete(event.id);
      state.queued.push({
        payload: { text: event.content, images: [] },
        displayKey: steer.displayKey,
        sessionFile: steer.sessionFile ?? ctx.runSessionFile,
      });
      return {
        state,
        effects: [
          { kind: "steer-requeued", id: event.id, displayKey: steer.displayKey },
          { kind: "queue-updated", pending: state.pendingSteers.size },
        ],
      };
    }
    case "input_pending_changed": {
      if (event.pending === 0 && state.pendingSteers.size > 0) {
        state.pendingSteers.clear();
      }
      return { state, effects: [{ kind: "queue-updated", pending: event.pending === 0 ? 0 : event.pending }] };
    }
    default:
      return { state, effects: [] };
  }
}

/**
 * Run-end drain for leftover steers (app.tsx:1904-1930):
 * cancelled → drop rows; normal end → requeue for the next turn.
 */
export function drainLeftoverSteers(
  state: InputQueueState,
  leftovers: Array<{ id: string; content: string }>,
  opts: { cancelled: boolean; runSessionFile?: string },
): QueueTransition {
  for (const leftover of leftovers) {
    const steer = state.pendingSteers.get(leftover.id);
    state.pendingSteers.delete(leftover.id);
    if (opts.cancelled) {
      if (steer) {
        // Row removal is a transcript effect the controller applies.
        void steer;
      }
      continue;
    }
    state.queued.push({
      payload: { text: leftover.content, images: [] },
      displayKey: steer?.displayKey,
      sessionFile: steer?.sessionFile ?? opts.runSessionFile,
    });
  }
  return {
    state,
    effects: [{ kind: "queue-updated", pending: state.pendingSteers.size }],
  };
}

/**
 * Attempt to submit the next queued input (app.tsx:2422-2435): all gates
 * must pass and the input must belong to the current session.
 */
export function drainNextQueued(
  state: InputQueueState,
  gate: QueueDrainGate,
): { state: InputQueueState; submit?: QueuedInput; droppedKeys: string[] } {
  if (gate.runActive || gate.startingSubmit || gate.overlayOpen) {
    return { state, submit: undefined, droppedKeys: [] };
  }
  while (state.queued.length > 0) {
    const next = state.queued.shift()!;
    if (!isQueuedInputForCurrentSession(next, gate.currentSessionFile)) {
      continue; // Stale placeholder from a switched-away session: skip.
    }
    return { state, submit: next, droppedKeys: [] };
  }
  return { state, submit: undefined, droppedKeys: [] };
}

/** Session switch: purge everything (app.tsx:989-995). */
export function purgeForSessionSwitch(state: InputQueueState): QueueTransition {
  state.queued.length = 0;
  state.pendingSteers.clear();
  return { state, effects: [{ kind: "queue-updated", pending: 0 }] };
}

function isQueuedInputForCurrentSession(input: QueuedInput, currentSessionFile?: string): boolean {
  if (!input.sessionFile || !currentSessionFile) return true;
  return input.sessionFile === currentSessionFile;
}

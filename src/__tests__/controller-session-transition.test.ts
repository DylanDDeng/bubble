/**
 * Session transition transaction tests (controller extraction §4).
 * Legacy reference: app.tsx:986-1018 (applySessionSwitch) + main.ts:711-759.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionTransitionController, type SessionTransitionDeps } from "../tui/controller/session-transition.js";
import { createInputQueueState, beginSteer, enqueue } from "../tui/controller/input-queue-machine.js";
import { OverlayRequestController } from "../tui/controller/overlay-controller.js";
import { ControllerState } from "../tui/controller/state.js";
import type { SessionManager } from "../session.js";
import type { DisplayMessage } from "../tui/model/display-history.js";

function fakeManager(file: string): { getSessionFile: () => string; getMetadata: () => { externalRuntime?: unknown } } {
  return {
    getSessionFile: () => file,
    getMetadata: () => ({}),
  };
}

function makeDeps(overrides: Partial<SessionTransitionDeps> = {}): SessionTransitionDeps & {
  commitCalls: Array<{ manager: SessionManager; transcript: DisplayMessage[] }>;
  generation: { value: number };
} {
  const commitCalls: Array<{ manager: SessionManager; transcript: DisplayMessage[] }> = [];
  const generation = { value: 0 };
  const deps: SessionTransitionDeps = {
    host: {
      switchSession: vi.fn(),
      createFresh: vi.fn(),
    } as never,
    state: new ControllerState(),
    overlays: new OverlayRequestController(),
    queue: createInputQueueState(),
    agent: { getMessages: () => [], setSessionID: vi.fn() },
    bumpExternalGeneration: () => {
      generation.value += 1;
    },
    clearLiveSubagentTools: vi.fn(),
    commit: (manager, transcript) => {
      commitCalls.push({ manager, transcript });
    },
    ...overrides,
  };
  return Object.assign(deps, { commitCalls, generation });
}

describe("session transition transaction", () => {
  it("prepare failure leaves the old session untouched: no commit, no notify", () => {
    const deps = makeDeps({
      host: { switchSession: () => ({ error: "boom" }) } as never,
    });
    const controller = new SessionTransitionController(deps);

    const outcome = controller.switchTo({ targetFile: "/new.jsonl" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("boom");
    expect(deps.commitCalls).toHaveLength(0);
    expect(deps.agent.setSessionID).not.toHaveBeenCalled();
    expect(deps.generation.value).toBe(0);
  });

  it("successful switch commits atomically: queue purged, agent rebound, overlays settled", () => {
    const deps = makeDeps({
      host: { switchSession: () => ({ manager: fakeManager("/new.jsonl") }) } as never,
    });
    enqueue(deps.queue, { payload: { text: "pending", images: [] }, displayKey: "m1" });
    beginSteer(deps.queue, { id: "s1", content: "steering", displayKey: "m2" });
    const planRef: { current?: (plan: string) => Promise<unknown> } = {};
    deps.overlays.installPlanHandler(planRef as never);
    const planPromise = planRef.current!("plan");

    const controller = new SessionTransitionController(deps);
    const outcome = controller.switchTo({ targetFile: "/new.jsonl", notice: "resumed" });

    expect(outcome.ok).toBe(true);
    expect(outcome.manager!.getSessionFile()).toBe("/new.jsonl");
    // Queue purged.
    expect(deps.queue.queued).toHaveLength(0);
    expect(deps.queue.pendingSteers.size).toBe(0);
    // Agent rebound.
    expect(deps.agent.setSessionID).toHaveBeenCalledWith("/new.jsonl");
    // External generation invalidated exactly once.
    expect(deps.generation.value).toBe(1);
    // Live subagent accumulator cleared.
    expect(deps.clearLiveSubagentTools).toHaveBeenCalled();
    // Blocking requests settled — the plan promise must not hang.
    return expect(planPromise).resolves.toBeUndefined();
  });

  it("single notification: commit fires exactly once per switch", () => {
    const deps = makeDeps({
      host: { switchSession: () => ({ manager: fakeManager("/a.jsonl") }) } as never,
    });
    const controller = new SessionTransitionController(deps);
    controller.switchTo({ targetFile: "/a.jsonl" });
    expect(deps.commitCalls).toHaveLength(1);
  });

  it("creates a fresh session through the same atomic commit", () => {
    const deps = makeDeps({
      host: {
        switchSession: vi.fn(),
        createFresh: () => ({ manager: fakeManager("/fresh.jsonl") }),
      } as never,
    });
    const controller = new SessionTransitionController(deps);
    const outcome = controller.createFresh("/cwd");
    expect(outcome.ok).toBe(true);
    expect(deps.agent.setSessionID).toHaveBeenCalledWith("/fresh.jsonl");
    expect(deps.commitCalls).toHaveLength(1);
  });

  it("buildTranscript appends the resume notice as the last row", () => {
    const deps = makeDeps({ agent: { getMessages: () => [], setSessionID: vi.fn() } });
    const controller = new SessionTransitionController(deps);
    const rows = controller.buildTranscript("⤷ Resumed session: x", new Set(["m1"]));
    const last = rows[rows.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("⤷ Resumed session: x");
    expect(last.key).toMatch(/^notice-/);
  });

  it("reads Agent.messages lazily after the host rebinds the history", () => {
    let messages: import("../types.js").Message[] = [{ role: "assistant", content: "old" }];
    const deps = makeDeps({
      agent: { getMessages: () => messages, setSessionID: vi.fn() },
      host: {
        switchSession: () => {
          messages = [{ role: "assistant", content: "new" }];
          return { manager: fakeManager("/new.jsonl") };
        },
        createFresh: vi.fn(),
      } as never,
    });
    const controller = new SessionTransitionController(deps);
    controller.switchTo({ targetFile: "/new.jsonl" });
    expect(deps.commitCalls[0]?.transcript).toContainEqual(expect.objectContaining({ content: "new" }));
    expect(deps.commitCalls[0]?.transcript.some((row) => row.content === "old")).toBe(false);
  });
});

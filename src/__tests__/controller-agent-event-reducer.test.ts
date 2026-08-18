/**
 * Unit tests for the pure agent-event reducer (controller extraction §2).
 * These encode the legacy switch semantics (app.tsx:1657-1854) so the
 * extraction is provably behavior-equivalent before any renderer consumes it.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../types.js";
import {
  buildAssistantMessage,
  createRunState,
  grokEventAllowed,
  reduceAgentEvent,
  reduceRunFinish,
  STREAMING_FLUSH_INTERVAL_MS,
  type RunContext,
} from "../tui/controller/agent-event-reducer.js";

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    external: false,
    isCurrentRun: () => true,
    now: () => 1_000,
    runStartedAt: 900,
    pendingSteers: new Map([
      ["steer-1", { displayKey: "msg-1", sessionFile: "/tmp/s.jsonl" }],
    ]),
    ...overrides,
  };
}

const ev = (event: AgentEvent) => event;

function subagentUpdate(fields: Partial<Extract<AgentEvent, { type: "tool_update" }>['update']> = {}) {
  return {
    type: "subagent_update" as const,
    parentToolCallId: "p1",
    runId: "r1",
    subAgentId: "s1",
    agentName: "worker",
    status: "running" as const,
    ...fields,
  };
}

describe("agent-event reducer", () => {
  it("exposes the legacy 40ms streaming flush interval", () => {
    expect(STREAMING_FLUSH_INTERVAL_MS).toBe(40);
  });

  it("accumulates text deltas with content dirty flag only", () => {
    let state = createRunState(1);
    state = reduceAgentEvent(state, ev({ type: "text_delta", content: "Hello" }), ctx()).state;
    state = reduceAgentEvent(state, ev({ type: "text_delta", content: " world" }), ctx()).state;

    expect(state.accumulator.content).toBe("Hello world");
    expect(state.dirty.content).toBe(true);
    expect(state.accumulator.parts).toHaveLength(1);
    expect(state.accumulator.parts[0]).toMatchObject({ type: "text", content: "Hello world" });
    // No immediate flush effect — batching is the controller's job.
    const { effects } = reduceAgentEvent(state, ev({ type: "text_delta", content: "!" }), ctx());
    expect(effects).toHaveLength(0);
  });

  it("accumulates reasoning separately", () => {
    let state = createRunState(1);
    state = reduceAgentEvent(state, ev({ type: "reasoning_delta", content: "hm" }), ctx()).state;
    expect(state.accumulator.reasoning).toBe("hm");
    expect(state.dirty.reasoning).toBe(true);
  });

  it("tracks the full tool lifecycle: start-placeholder -> delta -> start -> end", () => {
    let state = createRunState(1);
    let result = reduceAgentEvent(state, ev({ type: "tool_call_start", id: "t1", name: "bash" }), ctx());
    state = result.state;
    expect(state.accumulator.toolCalls).toHaveLength(1);
    expect(result.effects).toContainEqual({ kind: "tools-updated" });

    result = reduceAgentEvent(state, ev({ type: "tool_call_delta", id: "t1", name: "bash", argumentsDelta: "{\"", arguments: "{\"command\":" }), ctx());
    state = result.state;
    expect(state.accumulator.toolCalls[0]!.rawArguments).toBe("{\"command\":");

    // tool_call_end: intentionally no visual update (legacy comment at app.tsx:1723).
    result = reduceAgentEvent(state, ev({ type: "tool_call_end", id: "t1", name: "bash", arguments: "{}" }), ctx());
    expect(result.effects).toHaveLength(0);

    result = reduceAgentEvent(state, ev({ type: "tool_start", id: "t1", name: "bash", args: { command: "ls" } }), ctx());
    state = result.state;
    expect(state.accumulator.toolCalls[0]!.args).toEqual({ command: "ls" });
    expect(state.accumulator.toolCalls[0]!.startedAt).toBe(1_000);

    result = reduceAgentEvent(state, ev({
      type: "tool_end", id: "t1", name: "bash",
      result: { content: "done", isError: false },
    }), ctx());
    state = result.state;
    expect(state.accumulator.toolCalls[0]).toMatchObject({ result: "done", isError: false });
  });

  it("replaces the stream on turn_start (retry dedup)", () => {
    let state = createRunState(1);
    state = reduceAgentEvent(state, ev({ type: "text_delta", content: "half-built" }), ctx()).state;
    const { state: next, effects } = reduceAgentEvent(state, ev({ type: "turn_start" }), ctx());

    expect(next.accumulator.content).toBe("");
    expect(next.accumulator.parts).toHaveLength(0);
    expect(effects).toContainEqual({ kind: "stream-cleared" });
  });

  it("tool_update on an unknown id routes to the live subagent accumulator", () => {
    const state = createRunState(1);
    const { effects } = reduceAgentEvent(state, ev({
      type: "tool_update", id: "gone", name: "spawn_agent",
      update: subagentUpdate({ status: "running", metadata: { progress: "50%" } }),
    }), ctx());
    expect(effects).toContainEqual({ kind: "live-subagent-changed" });
  });

  it("tool_update marks failed/blocked/cancelled as errors", () => {
    let state = createRunState(1);
    state = reduceAgentEvent(state, ev({ type: "tool_call_start", id: "t9", name: "x" }), ctx()).state;
    for (const status of ["failed", "blocked", "cancelled"] as const) {
      const s2 = reduceAgentEvent(structuredClone(state), ev({
        type: "tool_update", id: "t9", name: "x",
        update: subagentUpdate({ status, message: "boom" }),
      }), ctx()).state;
      expect(s2.accumulator.toolCalls[0]!.isError).toBe(true);
      expect(s2.accumulator.toolCalls[0]!.result).toBe("boom");
    }
  });

  it("turn_end with willContinue commits without elapsed and clears", () => {
    let state = createRunState(1);
    state = reduceAgentEvent(state, ev({ type: "text_delta", content: "part one" }), ctx()).state;
    const { effects } = reduceAgentEvent(state, ev({ type: "turn_end", willContinue: true, usage: { promptTokens: 10, completionTokens: 5 } }), ctx());

    expect(effects).toContainEqual({ kind: "assistant-committed" });
    expect(effects).toContainEqual({ kind: "stream-cleared" });
    expect(effects.find((e) => e.kind === "assistant-committed")).not.toHaveProperty("taskElapsedMs");
  });

  it("final turn_end commits with elapsed time from run start", () => {
    const state = createRunState(1);
    const { effects } = reduceAgentEvent(state, ev({ type: "turn_end", systemFingerprint: "fp-1" }), ctx());
    const commit = effects.find((e) => e.kind === "assistant-committed");
    // ctx.now() - runStartedAt = 1000 - 900
    expect(commit).toMatchObject({ kind: "assistant-committed", taskElapsedMs: 100 });
  });

  it("emits permission-mode effects", () => {
    const { effects } = reduceAgentEvent(createRunState(1), ev({ type: "mode_changed", mode: "plan" }), ctx());
    expect(effects).toContainEqual({ kind: "permission-mode-changed", mode: "plan" });
  });

  it("steer events emit queue effects correlated by id", () => {
    const state = createRunState(1);
    const applied = reduceAgentEvent(state, ev({ type: "input_applied", id: "steer-1", content: "go", target: "current_turn" }), ctx());
    expect(applied.effects).toContainEqual({ kind: "steer-applied", id: "steer-1", displayKey: "msg-1" });

    const rejected = reduceAgentEvent(state, ev({ type: "input_rejected", id: "steer-1", content: "go", reason: "no_continuation", target: "next_turn" }), ctx());
    expect(rejected.effects).toContainEqual({ kind: "steer-requeued", id: "steer-1", displayKey: "msg-1" });

    const pending = reduceAgentEvent(state, ev({ type: "input_pending_changed", pending: 2 }), ctx());
    expect(pending.effects).toContainEqual({ kind: "queue-updated", pending: 2 });
  });

  it("silently ignores hook/context/provider/agent_end events", () => {
    const state = createRunState(1);
    const ignored: AgentEvent[] = [
      { type: "hook_start", eventName: "pre", hookId: "h", source: "config" },
      { type: "hook_end", eventName: "pre", hookId: "h", source: "config", elapsedMs: 1, decision: "allow" },
      { type: "hook_error", eventName: "pre", hookId: "h", source: "config", error: "x" },
      { type: "context_recovered", droppedMessages: 3, reason: "overflow" },
      { type: "provider_retry", attempt: 1, maxAttempts: 3, reason: "429" },
      { type: "agent_end" },
    ];
    for (const event of ignored) {
      const { state: next, effects } = reduceAgentEvent(state, event, ctx());
      expect(effects).toHaveLength(0);
      expect(next).toBe(state);
    }
  });

  it("grok whitelist: tool_call_* and reasoning outside the allowed set are violations", () => {
    expect(grokEventAllowed({ type: "text_delta", content: "x" })).toBe(true);
    expect(grokEventAllowed({ type: "turn_start" })).toBe(true);
    expect(grokEventAllowed({ type: "tool_call_start", id: "t", name: "n" })).toBe(false);
    expect(grokEventAllowed({ type: "mode_changed", mode: "default" })).toBe(false);
    expect(grokEventAllowed({ type: "input_applied", id: "i", content: "c", target: "current_turn" })).toBe(false);
  });

  it("external runs emit the policy-cancel effect on non-whitelisted events", () => {
    const state = createRunState(1);
    const { effects } = reduceAgentEvent(
      state,
      ev({ type: "tool_call_start", id: "t", name: "n" }),
      ctx({ external: true }),
    );
    expect(effects).toContainEqual({ kind: "external-cancel-policy" });
  });

  it("reduceRunFinish drains leftover steers and signals run end", () => {
    const state = { ...createRunState(1), outcome: "running" as const };
    const { state: next, effects } = reduceRunFinish(state, {
      cancelled: true,
      errored: false,
      leftoverSteers: [{ input: { id: "steer-1", content: "go" }, displayKey: "msg-1" }],
      ownsCurrentGeneration: true,
    });

    expect(next.outcome).toBe("cancelled");
    expect(effects).toContainEqual({
      kind: "steers-drained",
      cancelled: true,
      leftovers: [{ input: { id: "steer-1", content: "go" }, displayKey: "msg-1" }],
    });
    expect(effects).toContainEqual({ kind: "run-finished", cancelled: true, errored: false });
    expect(effects).toContainEqual({ kind: "queue-updated", pending: 0 });
  });

  it("reduceRunFinish on a stale generation only drains steers", () => {
    const { effects } = reduceRunFinish(createRunState(1), {
      cancelled: false,
      errored: false,
      leftoverSteers: [],
      ownsCurrentGeneration: false,
    });
    expect(effects.find((e) => e.kind === "run-finished")).toBeUndefined();
  });

  it("buildAssistantMessage snapshots content, reasoning, tools, and fingerprint", () => {
    let state = createRunState(1);
    state = reduceAgentEvent(state, ev({ type: "text_delta", content: "answer" }), ctx()).state;
    state = reduceAgentEvent(state, ev({ type: "reasoning_delta", content: "thinking" }), ctx()).state;
    state = reduceAgentEvent(state, ev({ type: "tool_call_start", id: "t1", name: "bash" }), ctx()).state;
    state = reduceAgentEvent(state, ev({ type: "tool_start", id: "t1", name: "bash", args: { command: "ls" } }), ctx()).state;
    state = reduceAgentEvent(state, ev({ type: "turn_end", systemFingerprint: "fp" }), ctx()).state;

    const message = buildAssistantMessage(state, 250);
    expect(message).toMatchObject({
      role: "assistant",
      content: "answer",
      reasoning: "thinking",
      systemFingerprint: "fp",
      taskElapsedMs: 250,
    });
    expect(message!.toolCalls).toHaveLength(1);
    expect(message!.key).toMatch(/^asst-/);
  });

  it("buildAssistantMessage returns null for an empty run", () => {
    expect(buildAssistantMessage(createRunState(1))).toBeNull();
  });

  it("buildAssistantMessage drops non-positive elapsed", () => {
    let state = createRunState(1);
    state = reduceAgentEvent(state, ev({ type: "text_delta", content: "x" }), ctx()).state;
    expect(buildAssistantMessage(state, 0)?.taskElapsedMs).toBeUndefined();
    expect(buildAssistantMessage(state, Number.NaN)?.taskElapsedMs).toBeUndefined();
  });
});

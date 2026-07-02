import { describe, expect, it } from "vitest";
import type { AgentEvent, ToolResult } from "../../types.js";
import { createInitialRunState } from "../card/run-state-types.js";
import {
  reduceRunState,
  markError,
  markInterrupted,
  markIdleTimeout,
  hasInFlightTool,
} from "../card/run-state.js";

function makeState() {
  return createInitialRunState({
    scope: { chatId: "oc_test", userId: "ou_test", displayName: "test", cwd: "/tmp/test" },
    mode: "default",
  });
}

function okResult(content: string): ToolResult {
  return { content };
}

describe("run-state reducer", () => {
  it("appends text_delta into a streaming text block", () => {
    const state = makeState();
    reduceRunState(state, { type: "text_delta", content: "hello " });
    reduceRunState(state, { type: "text_delta", content: "world" });
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "text", text: "hello world", streaming: true });
  });

  it("closes streaming text when a tool starts and opens a tool block", () => {
    const state = makeState();
    reduceRunState(state, { type: "text_delta", content: "About to read" });
    reduceRunState(state, { type: "tool_start", id: "t1", name: "Read", args: { path: "/tmp/x" } });
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ kind: "text", streaming: false });
    expect(state.blocks[1]).toMatchObject({ kind: "tool", id: "t1", status: "running" });
  });

  it("updates tool block on tool_end", () => {
    const state = makeState();
    reduceRunState(state, { type: "tool_start", id: "t1", name: "Read", args: { path: "/x" } });
    reduceRunState(state, { type: "tool_end", id: "t1", name: "Read", result: okResult("File contents") });
    const tool = state.blocks.find((b) => b.kind === "tool");
    expect(tool).toMatchObject({ id: "t1", status: "ok", resultPreview: "File contents" });
  });

  it("marks tool block as err when result.isError", () => {
    const state = makeState();
    reduceRunState(state, { type: "tool_start", id: "t1", name: "Bash", args: { command: "exit 1" } });
    reduceRunState(state, { type: "tool_end", id: "t1", name: "Bash", result: { content: "boom", isError: true } });
    expect(state.blocks[0]).toMatchObject({ kind: "tool", status: "err" });
  });

  it("drops the discarded partial attempt on turn_start (stream-interruption retry)", () => {
    const state = makeState();
    reduceRunState(state, { type: "turn_start" });
    reduceRunState(state, { type: "text_delta", content: "统计日期: 2026-07-02 | 数据" });
    // Stream dies mid-response; the agent discards the partial assistant
    // message, emits provider_retry, and re-enters the loop with turn_start.
    reduceRunState(state, { type: "turn_start" });
    reduceRunState(state, { type: "text_delta", content: "统计日期: 2026-07-02 | 数据范围: 完整回答" });
    reduceRunState(state, { type: "turn_end", willContinue: false });

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: "text",
      text: "统计日期: 2026-07-02 | 数据范围: 完整回答",
      streaming: false,
    });
  });

  it("keeps settled turns across turn boundaries", () => {
    const state = makeState();
    reduceRunState(state, { type: "turn_start" });
    reduceRunState(state, { type: "text_delta", content: "first turn" });
    reduceRunState(state, { type: "turn_end", willContinue: true });
    reduceRunState(state, { type: "turn_start" });
    reduceRunState(state, { type: "text_delta", content: "second turn" });

    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ kind: "text", text: "first turn", streaming: false });
    expect(state.blocks[1]).toMatchObject({ kind: "text", text: "second turn", streaming: true });
  });

  it("merges usage on turn_end", () => {
    const state = makeState();
    reduceRunState(state, {
      type: "turn_end",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    reduceRunState(state, {
      type: "turn_end",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(state.usage).toMatchObject({ promptTokens: 110, completionTokens: 55, totalTokens: 165 });
  });

  it("sets status to completed on agent_end", () => {
    const state = makeState();
    reduceRunState(state, { type: "text_delta", content: "done" });
    reduceRunState(state, { type: "agent_end" });
    expect(state.status).toBe("completed");
    expect(state.blocks[0]).toMatchObject({ streaming: false });
  });

  it("reflects mode change in state", () => {
    const state = makeState();
    reduceRunState(state, { type: "mode_changed", mode: "bypassPermissions" });
    expect(state.mode).toBe("bypassPermissions");
  });

  it("markInterrupted closes streaming and sets status", () => {
    const state = makeState();
    reduceRunState(state, { type: "text_delta", content: "half" });
    markInterrupted(state);
    expect(state.status).toBe("interrupted");
    expect(state.blocks[0]).toMatchObject({ streaming: false });
  });

  it("markError captures message", () => {
    const state = makeState();
    markError(state, new Error("provider down"));
    expect(state.status).toBe("error");
    expect(state.error?.message).toBe("provider down");
  });

  it("markIdleTimeout only triggers when status is running", () => {
    const state = makeState();
    markIdleTimeout(state);
    expect(state.status).toBe("idle_timeout");
    // After interrupted, idle should not override.
    const state2 = makeState();
    markInterrupted(state2);
    markIdleTimeout(state2);
    expect(state2.status).toBe("interrupted");
  });

  it("hasInFlightTool detects running tools", () => {
    const state = makeState();
    expect(hasInFlightTool(state)).toBe(false);
    reduceRunState(state, { type: "tool_start", id: "t1", name: "Read", args: {} });
    expect(hasInFlightTool(state)).toBe(true);
    reduceRunState(state, { type: "tool_end", id: "t1", name: "Read", result: okResult("ok") });
    expect(hasInFlightTool(state)).toBe(false);
  });

  it("truncates absurdly large streaming text deltas", () => {
    const state = makeState();
    const huge = "x".repeat(20_000);
    reduceRunState(state, { type: "text_delta", content: huge });
    const block = state.blocks[0];
    expect(block?.kind).toBe("text");
    if (block?.kind === "text") {
      // bounded to 12k chars (TEXT_BLOCK_MAX_CHARS)
      expect(block.text.length).toBeLessThanOrEqual(12_001);
    }
  });
});

describe("formatArgsPreview behavior (via tool_start)", () => {
  it("produces a one-liner preview for typical args", () => {
    const state = makeState();
    reduceRunState(state, {
      type: "tool_start",
      id: "t1",
      name: "Bash",
      args: { command: "ls -la", cwd: "/tmp" },
    });
    const tool = state.blocks[0];
    if (tool?.kind === "tool") {
      expect(tool.argsPreview).toContain("command=");
      expect(tool.argsPreview).toContain("ls -la");
    }
  });

  it("does not crash on unserializable values", () => {
    const state = makeState();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    reduceRunState(state, { type: "tool_start", id: "t1", name: "X", args: { thing: circular } });
    expect(state.blocks).toHaveLength(1);
  });
});

describe("agent events not visible in state", () => {
  it("ignores tool_call_start / delta / end (args streaming)", () => {
    const state = makeState();
    const events: AgentEvent[] = [
      { type: "tool_call_start", id: "t1", name: "Bash" },
      { type: "tool_call_delta", id: "t1", name: "Bash", argumentsDelta: "{}", arguments: "{}" },
      { type: "tool_call_end", id: "t1", name: "Bash", arguments: "{}" },
    ];
    for (const e of events) reduceRunState(state, e);
    expect(state.blocks).toHaveLength(0);
  });
});

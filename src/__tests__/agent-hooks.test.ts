import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../agent.js";
import { AgentRunInputQueue } from "../agent/input-controller.js";
import { ExternalHookController } from "../hooks/index.js";
import type { AgentEvent, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

function providerFromTurns(turns: StreamChunk[][], onCall?: () => void): Provider {
  let index = 0;
  return {
    async *streamChat() {
      onCall?.();
      const chunks = turns[index++] ?? [];
      for (const chunk of chunks) yield chunk;
    },
    async complete() {
      return "complete";
    },
  };
}

function tmpHooks(rules: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "bubble-agent-hooks-"));
  const bubbleHome = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(bubbleHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(bubbleHome, "settings.json"), JSON.stringify({ hooks: { rules } }, null, 2), "utf-8");
  return { cwd, bubbleHome, hooks: new ExternalHookController({ cwd, bubbleHome }) };
}

function jsonHook(source: string) {
  return {
    command: process.execPath,
    args: ["-e", source],
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("agent lifecycle hooks", () => {
  it("blocks UserPromptSubmit before the prompt is appended or sent to the provider", async () => {
    let providerCalls = 0;
    const { cwd, hooks } = tmpHooks([{
      id: "block-prompt",
      event: "UserPromptSubmit",
      ...jsonHook("process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'deny',reason:'blocked prompt'})))"),
    }]);
    const agent = new Agent({
      provider: providerFromTurns([[{ type: "text", content: "should not run" }]], () => providerCalls++),
      model: "test-model",
      tools: [],
      externalHooks: hooks,
    });

    const events = await collect(agent.run("hello", cwd));

    expect(providerCalls).toBe(0);
    expect(agent.messages.some((message) => message.role === "user")).toBe(false);
    expect(events).toContainEqual({ type: "text_delta", content: "blocked prompt" });
  });

  it("turns PreToolUse deny into an error tool result without executing the tool", async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: unknown) => ({ content: "executed" }));
    const tool: ToolRegistryEntry = {
      name: "danger",
      description: "Dangerous test tool",
      parameters: { type: "object", properties: {} },
      async execute(args, ctx) {
        return execute(args, ctx);
      },
    };
    const { cwd, hooks } = tmpHooks([{
      id: "deny-tool",
      event: "PreToolUse",
      matcher: "^danger$",
      ...jsonHook("process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'deny',reason:'tool blocked'})))"),
    }]);
    const agent = new Agent({
      provider: providerFromTurns([
        [{ type: "tool_call", id: "call_1", name: "danger", arguments: "{}", isStart: true, isEnd: true }],
        [{ type: "text", content: "done" }],
      ]),
      model: "test-model",
      tools: [tool],
      externalHooks: hooks,
    });

    const events = await collect(agent.run("run danger", cwd));
    const toolEnd = events.find((event) => event.type === "tool_end");

    expect(execute).not.toHaveBeenCalled();
    expect(toolEnd).toMatchObject({
      type: "tool_end",
      name: "danger",
      result: { content: "tool blocked", isError: true },
    });
  });

  it("emits SteerInputApplied hooks for pending current-turn input", async () => {
    const { cwd, hooks } = tmpHooks([{
      id: "steer-observer",
      event: "SteerInputApplied",
      ...jsonHook("process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'allow'})))"),
    }]);
    const inputController = new AgentRunInputQueue();
    inputController.enqueue("second message");
    const agent = new Agent({
      provider: providerFromTurns([[{ type: "text", content: "ok" }]]),
      model: "test-model",
      tools: [],
      externalHooks: hooks,
    });

    const events = await collect(agent.run("first message", cwd, { inputController }));

    expect(events.some((event) => event.type === "hook_start" && event.eventName === "SteerInputApplied")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "input_applied",
      content: "second message",
      target: "current_turn",
    }));
  });
});

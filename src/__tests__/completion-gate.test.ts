import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentEvent, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

// The completion self-check gate (default-hooks afterTurn): when a run that
// changed code is about to end, remind the model ONCE to re-read the original
// request. Regression-locks the four guards: single-fire latch, codeChanged
// gating, forceTextOnly mutex (covered via latch semantics), subagent
// exemption.

function providerFromTurns(turns: StreamChunk[][], onCall?: () => void): Provider {
  let index = 0;
  return {
    async *streamChat() {
      onCall?.();
      const chunks = turns[index++] ?? [{ type: "text", content: "fallback final answer" }];
      for (const chunk of chunks) yield chunk;
      yield { type: "done" };
    },
    async complete() {
      return "complete";
    },
  };
}

function fakeWriteTool(): ToolRegistryEntry {
  return {
    name: "write",
    description: "write a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() {
      return {
        content: "ok",
        isError: false,
        metadata: { kind: "write", path: "/tmp/x" },
      };
    },
  } as unknown as ToolRegistryEntry;
}

function writeCallTurn(): StreamChunk[] {
  return [
    { type: "tool_call", id: "w1", name: "write", arguments: "", isStart: true, isEnd: false },
    { type: "tool_call", id: "w1", name: "write", arguments: "", argumentsFull: '{"path":"/tmp/x"}', isStart: false, isEnd: true },
  ];
}

function textTurn(content: string): StreamChunk[] {
  return [{ type: "text", content }];
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("completion self-check gate", () => {
  it("fires exactly once after code changes: final turn continues, next final turn ends the run", async () => {
    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns(
        [
          writeCallTurn(),               // turn 1: writes a file (codeChanged)
          textTurn("all done"),          // turn 2: tries to finish -> gate fires
          textTurn("confirmed, final"),  // turn 3: finishes for real
        ],
        () => providerCalls++,
      ),
      model: "test-model",
      tools: [fakeWriteTool()],
    });

    const events = await collect(agent.run("change the file", process.cwd()));

    // Three model calls: the gate bought exactly one extra turn.
    expect(providerCalls).toBe(3);
    const turnEnds = events.filter((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
    // The gated turn is marked willContinue; the last one is not.
    expect(turnEnds.at(-2)?.willContinue).toBe(true);
    expect(turnEnds.at(-1)?.willContinue).toBe(false);
    // The self-check reminder landed in resident history as a meta message.
    const reminderInHistory = agent.messages.some((m) =>
      m.role === "meta" && m.content.includes("re-read the user's original request"));
    expect(reminderInHistory).toBe(true);
  });

  it("does not fire on runs that never changed code", async () => {
    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns([textTurn("the answer is 42")], () => providerCalls++),
      model: "test-model",
      tools: [fakeWriteTool()],
    });

    await collect(agent.run("what is 6*7?", process.cwd()));

    expect(providerCalls).toBe(1);
  });

  it("does not fire for subagents", async () => {
    let providerCalls = 0;
    const agent = new Agent({
      provider: providerFromTurns(
        [writeCallTurn(), textTurn("done")],
        () => providerCalls++,
      ),
      model: "test-model",
      tools: [fakeWriteTool()],
      agentRole: "subagent",
    });

    await collect(agent.run("change the file", process.cwd()));

    // write turn + final text turn, no extra gated turn.
    expect(providerCalls).toBe(2);
  });
});

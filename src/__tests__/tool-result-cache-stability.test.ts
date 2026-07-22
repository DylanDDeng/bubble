import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentEvent, Message, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

// The cache-stability mark must exist on a tool result at the moment it is
// handed to onMessageAppend: the session log serializes the message right then,
// so a mark applied on a later turn never reaches disk and a resumed session
// re-prunes history the model was already shown in full.

function providerFromTurns(turns: StreamChunk[][]): Provider {
  let index = 0;
  return {
    async *streamChat() {
      const chunks = turns[index++] ?? [{ type: "text", content: "done" }];
      for (const chunk of chunks) yield chunk;
      yield { type: "done" };
    },
    async complete() { return "complete"; },
  };
}

function readTool(): ToolRegistryEntry {
  return {
    name: "read",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() {
      return { content: "x".repeat(500), isError: false, metadata: { kind: "read" } };
    },
  } as unknown as ToolRegistryEntry;
}

describe("tool result cache-stability marking at persist time", () => {
  it("marks the tool result before onMessageAppend fires", async () => {
    const persisted: Message[] = [];
    const agent = new Agent({
      provider: providerFromTurns([
        [
          { type: "tool_call", id: "r1", name: "read", arguments: "", isStart: true, isEnd: false },
          { type: "tool_call", id: "r1", name: "read", arguments: "", argumentsFull: '{"path":"a.ts"}', isStart: false, isEnd: true },
        ],
        [{ type: "text", content: "done" }],
      ]),
      model: "test-model",
      tools: [readTool()],
      onMessageAppend: (message) => persisted.push(JSON.parse(JSON.stringify(message))),
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("read a.ts", process.cwd())) events.push(event);

    const toolMessage = persisted.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect((toolMessage as { metadata?: Record<string, unknown> }).metadata)
      .toMatchObject({ cacheStableProjection: "full" });
  });
});

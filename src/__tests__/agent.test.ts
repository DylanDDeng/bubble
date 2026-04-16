import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentEvent, Message, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

function createMockProvider(chunks: StreamChunk[][]): Provider {
  let callIndex = 0;
  return {
    async *streamChat(_messages, _options) {
      const current = chunks[callIndex++] || [];
      for (const chunk of current) {
        yield chunk;
      }
    },
    async complete(messages, options) {
      return "mock completion";
    },
  };
}

function collectEvents(agent: Agent, input: string, cwd: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  return (async () => {
    for await (const event of agent.run(input, cwd)) {
      events.push(event);
    }
    return events;
  })();
}

describe("Agent", () => {
  const dummyTool: ToolRegistryEntry = {
    name: "dummy",
    description: "A dummy tool",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    async execute(args) {
      return { content: `result: ${args.value}` };
    },
  };

  it("handles a simple text response", async () => {
    const provider = createMockProvider([
      [{ type: "text", content: "Hello!" }, { type: "done" }],
    ]);
    const agent = new Agent({ provider, model: "gpt-4o", tools: [] });
    const events = await collectEvents(agent, "Hi", "/tmp");

    expect(events.some((e) => e.type === "text_delta" && e.content === "Hello!")).toBe(true);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
    expect(agent.messages).toHaveLength(2); // user + assistant (no system prompt in this test)
  });

  it("auto-continues after a tool call", async () => {
    const provider = createMockProvider([
      [
        { type: "tool_call", id: "tc_1", name: "dummy", arguments: "", isStart: true, isEnd: false },
        {
          type: "tool_call",
          id: "tc_1",
          name: "dummy",
          arguments: '{"value":"42"}',
          isStart: false,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "Done!" }, { type: "done" }],
    ]);

    const agent = new Agent({ provider, model: "gpt-4o", tools: [dummyTool] });
    const events = await collectEvents(agent, "Call dummy", "/tmp");

    expect(events.some((e) => e.type === "tool_start" && e.name === "dummy")).toBe(true);
    expect(events.some((e) => e.type === "tool_end" && e.result.content === "result: 42")).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.content === "Done!")).toBe(true);
    expect(agent.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("reports unknown tool error", async () => {
    const provider = createMockProvider([
      [
        {
          type: "tool_call",
          id: "tc_1",
          name: "nonexistent",
          arguments: "{}",
          isStart: true,
          isEnd: true,
        },
        { type: "done" },
      ],
      [{ type: "text", content: "Sorry" }, { type: "done" }],
    ]);

    const agent = new Agent({ provider, model: "gpt-4o", tools: [dummyTool] });
    const events = await collectEvents(agent, "Test", "/tmp");

    const toolEnd = events.find((e) => e.type === "tool_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content).toContain("Unknown tool");
  });

  it("calls onMessageAppend for each message", async () => {
    const appended: Message[] = [];
    const provider = createMockProvider([
      [{ type: "text", content: "ok" }, { type: "done" }],
    ]);
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      onMessageAppend: (m) => appended.push(m),
    });

    await collectEvents(agent, "Hi", "/tmp");
    expect(appended.some((m) => m.role === "user")).toBe(true);
    expect(appended.some((m) => m.role === "assistant")).toBe(true);
  });

  it("projects messages before sending them to the provider", async () => {
    const captured: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        captured.push(messages);
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
      async complete() {
        return "ok";
      },
    };

    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      systemPrompt: "system-1",
    });

    agent.messages.unshift({ role: "system", content: "system-0" });
    agent.messages.push({ role: "assistant", content: "" });

    await collectEvents(agent, "Hi", "/tmp");

    expect(captured).toHaveLength(1);
    expect(captured[0][0].role).toBe("system");
    expect((captured[0][0] as any).content).toContain("system-0");
    expect((captured[0][0] as any).content).toContain("system-1");
    expect(captured[0].some((message) => message.role === "assistant" && message.content === "")).toBe(false);
  });
});

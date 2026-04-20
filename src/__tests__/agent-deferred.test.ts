import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { Provider, StreamChunk, ToolDefinition, ToolRegistryEntry } from "../types.js";

/**
 * Provider spy that records the tool definitions it receives each turn, so
 * tests can assert what the agent sends to the model.
 */
function spyProvider(): {
  provider: Provider;
  lastTools: () => ToolDefinition[] | undefined;
  turns: () => number;
} {
  let last: ToolDefinition[] | undefined;
  let turns = 0;
  const provider: Provider = {
    async *streamChat(_messages, options): AsyncIterable<StreamChunk> {
      turns += 1;
      last = options.tools ?? [];
      yield { type: "text", content: "ok" };
      yield { type: "done" };
    },
    async complete() {
      return "";
    },
  };
  return { provider, lastTools: () => last, turns: () => turns };
}

function makeTool(name: string, opts: { deferred?: boolean } = {}): ToolRegistryEntry {
  return {
    name,
    description: `${name} does things`,
    parameters: { type: "object", properties: {}, required: [] },
    deferred: opts.deferred,
    async execute() {
      return { content: "done" };
    },
  };
}

describe("Agent deferred tools", () => {
  it("hides deferred tools from the per-turn tool list until unlocked", async () => {
    const { provider, lastTools } = spyProvider();
    const tools = [
      makeTool("read"),
      makeTool("mcp__arxiv__search_papers", { deferred: true }),
      makeTool("mcp__arxiv__download_paper", { deferred: true }),
    ];
    const agent = new Agent({ provider, model: "gpt-4o", tools });

    for await (const _ of agent.run("go", "/tmp")) { /* drain */ }
    const namesTurn1 = lastTools()!.map((t) => t.name).sort();
    expect(namesTurn1).toEqual(["read"]);

    agent.unlockDeferredTools(["mcp__arxiv__search_papers"]);

    for await (const _ of agent.run("again", "/tmp")) { /* drain */ }
    const namesTurn2 = lastTools()!.map((t) => t.name).sort();
    expect(namesTurn2).toEqual(["mcp__arxiv__search_papers", "read"]);
  });

  it("injects a deferred-tools system-reminder at construction when any deferred tools exist", async () => {
    const { provider } = spyProvider();
    const tools = [makeTool("mcp__arxiv__search_papers", { deferred: true })];
    const agent = new Agent({ provider, model: "gpt-4o", tools });

    const meta = agent.messages.find(
      (m) => m.role === "user" && (m as any).isMeta && String((m as any).content).includes("deferred tools"),
    );
    expect(meta).toBeDefined();
    expect(String((meta as any).content)).toContain("mcp__arxiv__search_papers");
  });

  it("refuses to execute a deferred tool that has not been unlocked", async () => {
    const { provider } = spyProvider();
    const tools = [makeTool("mcp__arxiv__search_papers", { deferred: true })];
    const agent = new Agent({ provider, model: "gpt-4o", tools });

    // Simulate the model calling a locked deferred tool by driving run() with a
    // provider that emits a tool_call. Easiest: override provider on the fly.
    (agent as any).provider = {
      async *streamChat(): AsyncIterable<StreamChunk> {
        yield { type: "tool_call", id: "tc", name: "mcp__arxiv__search_papers", arguments: "{}", isStart: true, isEnd: true };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
    } satisfies Provider;

    // Drain first turn (tool call + its error result), then the second turn emits the reply we seed below.
    let toolEndContent: string | undefined;
    let secondTurn = false;
    (agent as any).provider = {
      async *streamChat(): AsyncIterable<StreamChunk> {
        if (!secondTurn) {
          secondTurn = true;
          yield { type: "tool_call", id: "tc", name: "mcp__arxiv__search_papers", arguments: "{}", isStart: true, isEnd: true };
          yield { type: "done" };
        } else {
          yield { type: "text", content: "noted" };
          yield { type: "done" };
        }
      },
      async complete() {
        return "";
      },
    } satisfies Provider;

    for await (const event of agent.run("call it", "/tmp")) {
      if (event.type === "tool_end") {
        toolEndContent = event.result.content;
      }
    }
    expect(toolEndContent).toContain("deferred");
    expect(toolEndContent).toContain("tool_search");
  });
});

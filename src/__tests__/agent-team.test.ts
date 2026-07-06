import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { discoverAgentProfiles, findAgentProfile, type AgentProfile } from "../agent/profiles.js";
import { RateLimitError } from "../network/errors.js";
import { createAgentLifecycleTools } from "../tools/agent-lifecycle.js";
import type { AgentEvent, Message, Provider, StreamChunk, ToolUpdate } from "../types.js";

const LONG_SUMMARY = "Complete handoff: findings, conclusions, and unfinished items with file-level evidence. ".repeat(4);

function defaultProfile(): AgentProfile {
  return findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
}

function textProvider(summary = LONG_SUMMARY): Provider {
  return {
    async *streamChat() {
      yield { type: "text", content: summary } satisfies StreamChunk;
      yield { type: "done" } satisfies StreamChunk;
    },
    async complete() {
      return "complete";
    },
  };
}

describe("agent_team runtime", () => {
  it("fans out one child per item, streams member updates via directEmit, and returns results in item order", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const updates: ToolUpdate[] = [];

    const snapshots = await agent.runAgentTeam("/tmp", {
      profile: defaultProfile(),
      promptTemplate: "Review {{item}} for risks.",
      items: ["src/a.ts", "src/b.ts", "src/c.ts"],
      parentToolCallId: "team_1",
      emitUpdate: (update) => updates.push(update),
    });

    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((snapshot) => snapshot.task)).toEqual([
      "Review src/a.ts for risks.",
      "Review src/b.ts for risks.",
      "Review src/c.ts for risks.",
    ]);
    expect(snapshots.every((snapshot) => snapshot.status === "completed")).toBe(true);
    // Member events reached the tool's own update channel (directEmit), the
    // only channel drained while a foreground tool blocks the parent loop.
    expect(updates.length).toBeGreaterThan(0);
    expect(new Set(updates.map((update) => update.subAgentId)).size).toBe(3);
    // The aggregated reply delivers every member's summary.
    expect(snapshots.every((snapshot) => snapshot.deliveredAt !== undefined)).toBe(true);
  });

  it("keeps member failures independent and marks failed members resumable", async () => {
    let call = 0;
    const provider: Provider = {
      async *streamChat() {
        call += 1;
        if (call === 1) {
          throw new Error("member exploded");
        }
        yield { type: "text", content: LONG_SUMMARY } satisfies StreamChunk;
        yield { type: "done" } satisfies StreamChunk;
      },
      async complete() {
        return "complete";
      },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { maxActiveSubagents: 1 },
    });

    const snapshots = await agent.runAgentTeam("/tmp", {
      profile: defaultProfile(),
      promptTemplate: "Inspect {{item}}.",
      items: ["one", "two"],
      parentToolCallId: "team_1",
    });

    const statuses = snapshots.map((snapshot) => snapshot.status).sort();
    expect(statuses).toEqual(["completed", "failed"]);
    const failed = snapshots.find((snapshot) => snapshot.status === "failed")!;
    expect(failed.finalReason).toBe("failed_transient");
    expect(failed.resumable).toBe(true);
  });

  it("drives every member to a final state under injected RateLimitError with a single backoff layer and one input copy per child", async () => {
    const items = Array.from({ length: 8 }, (_, index) => `module-${index}`);
    let calls = 0;
    const provider: Provider = {
      async *streamChat() {
        calls += 1;
        // The first 8 calls (one per member) are rate limited; retries succeed.
        if (calls <= items.length) {
          throw new RateLimitError("429", { retryAfterMs: 0 });
        }
        yield { type: "text", content: LONG_SUMMARY } satisfies StreamChunk;
        yield { type: "done" } satisfies StreamChunk;
      },
      async complete() {
        return "complete";
      },
    };
    const agent = new Agent({
      provider,
      model: "gpt-4o",
      tools: [],
      subagents: { maxActiveSubagents: 8, launchIntervalMs: 0, rateLimitBackoffMs: [0, 0, 0] },
    });

    const snapshots = await agent.runAgentTeam("/tmp", {
      profile: defaultProfile(),
      promptTemplate: "Audit {{item}}.",
      items,
      parentToolCallId: "team_1",
    });

    expect(snapshots.every((snapshot) => snapshot.status === "completed")).toBe(true);
    // Single backoff layer: every member used exactly one failed call and one
    // successful call — no hidden transport retries stacked on top.
    expect(calls).toBe(items.length * 2);

    for (const snapshot of snapshots) {
      const record = (agent as any).subagentStore.get(snapshot.agentId);
      const userMessages = (record.agent.messages as Message[]).filter((message) => message.role === "user");
      expect(userMessages).toHaveLength(1);
    }
  });

});

describe("agent_team tool", () => {
  function teamToolFor(agent: Agent) {
    const tools = createAgentLifecycleTools({ cwd: "/tmp" });
    return { tool: tools.find((tool) => tool.name === "agent_team")!, ctxAgent: agent };
  }

  it("validates template placeholder and unique item count with teaching errors", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const { tool } = teamToolFor(agent);
    const ctx = { cwd: "/tmp", toolCall: { id: "s1", name: "agent_team" }, agent: agent as any };

    const noPlaceholder = await tool.execute({ description: "x", prompt_template: "Review it", items: ["a", "b"] }, ctx);
    expect(noPlaceholder.isError).toBe(true);
    expect(noPlaceholder.content).toContain("{{item}}");

    const tooFew = await tool.execute({ description: "x", prompt_template: "Review {{item}}", items: ["a", "a", " a "] }, ctx);
    expect(tooFew.isError).toBe(true);
    expect(tooFew.content).toContain("at least 2 unique items");

    const tooMany = await tool.execute({
      description: "x",
      prompt_template: "Review {{item}}",
      items: Array.from({ length: 40 }, (_, index) => `item-${index}`),
    }, ctx);
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content).toContain("at most 32");
  });

  it("runs members and aggregates per-item results in order", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const { tool } = teamToolFor(agent);
    const ctx = { cwd: "/tmp", toolCall: { id: "s1", name: "agent_team" }, agent: agent as any };

    const result = await tool.execute({
      description: "review modules",
      prompt_template: "Review {{item}} for risks.",
      items: ["src/a.ts", "src/b.ts"],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.status).toBe("success");
    expect(result.content).toContain("2 members");
    expect(result.content.indexOf("item 1: src/a.ts")).toBeLessThan(result.content.indexOf("item 2: src/b.ts"));
    const metadata = result.metadata as { mode?: string; subagents?: unknown[] };
    expect(metadata.mode).toBe("team");
    expect(metadata.subagents).toHaveLength(2);
  });
});

describe("agent_team exclusivity", () => {
  it("blocks agent_team when it shares a response with other tool calls, with a teaching message", async () => {
    const provider: Provider = (() => {
      let turn = 0;
      return {
        async *streamChat() {
          turn += 1;
          if (turn === 1) {
            yield { type: "tool_call", id: "read_1", name: "read", arguments: "{}", isStart: true, isEnd: true } satisfies StreamChunk;
            yield {
              type: "tool_call",
              id: "team_1",
              name: "agent_team",
              arguments: JSON.stringify({ description: "x", prompt_template: "Review {{item}}", items: ["a", "b"] }),
              isStart: true,
              isEnd: true,
            } satisfies StreamChunk;
            yield { type: "done" } satisfies StreamChunk;
            return;
          }
          yield { type: "text", content: "done" } satisfies StreamChunk;
          yield { type: "done" } satisfies StreamChunk;
        },
        async complete() {
          return "complete";
        },
      };
    })();

    const readTool = {
      name: "read",
      readOnly: true,
      effect: "read" as const,
      description: "Read",
      parameters: { type: "object" as const, properties: {} },
      async execute() {
        return { content: "tool result" };
      },
    };
    const teamTool = createAgentLifecycleTools({ cwd: "/tmp" }).find((tool) => tool.name === "agent_team")!;
    const agent = new Agent({ provider, model: "gpt-4o", tools: [readTool, teamTool] });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("go", "/tmp")) {
      events.push(event);
    }

    const teamEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end" && event.name === "agent_team",
    );
    expect(teamEnd).toBeDefined();
    expect(teamEnd!.result.isError).toBe(true);
    expect(teamEnd!.result.content).toContain("must be the only tool call");
    const readEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end" && event.name === "read",
    );
    expect(readEnd!.result.isError).toBeFalsy();
  });
});

describe("subagent lifecycle hooks under rate limits", () => {
  it("fires SubagentStart/Stop exactly once per logical run across 429 retries", async () => {
    const hookEvents: string[] = [];
    const externalHooks = {
      runEvent: async (request: { eventName: string }) => {
        if (request.eventName === "SubagentStart" || request.eventName === "SubagentStop") {
          hookEvents.push(request.eventName);
        }
        return {
          eventName: request.eventName,
          decision: "allow",
          modelContext: [],
          results: [],
          diagnostics: [],
          matched: 0,
        };
      },
    } as any;

    let calls = 0;
    const provider: Provider = {
      async *streamChat() {
        calls += 1;
        if (calls === 1) {
          throw new RateLimitError("429", { retryAfterMs: 0 });
        }
        yield { type: "text", content: LONG_SUMMARY } satisfies StreamChunk;
        yield { type: "done" } satisfies StreamChunk;
      },
      async complete() {
        return "complete";
      },
    };
    const agent = new Agent({ provider, model: "gpt-4o", tools: [], externalHooks });
    const profile = defaultProfile();

    const spawned = await agent.spawnSubAgent("task", "/tmp", { profile, parentToolCallId: "spawn_1" });
    await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 5_000 });

    expect(calls).toBe(2);
    expect(hookEvents).toEqual(["SubagentStart", "SubagentStop"]);
  });
});

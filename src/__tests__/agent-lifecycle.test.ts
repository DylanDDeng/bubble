import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { discoverAgentProfiles, findAgentProfile } from "../agent/profiles.js";
import { createSpawnAgentTool } from "../tools/agent-lifecycle.js";
import type { Provider, StreamChunk, ToolContext, ToolRegistryEntry } from "../types.js";

function providerFromTurns(turns: StreamChunk[][]): Provider {
  let index = 0;
  return {
    async *streamChat(_messages, _options) {
      const chunks = turns[index++] ?? [];
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield chunk;
      }
    },
    async complete() {
      return "complete";
    },
  };
}

describe("subagent lifecycle", () => {
  it("shows the resolved provider/model route in the spawn result", async () => {
    const spawnTool = createSpawnAgentTool();
    const ctx: ToolContext = {
      cwd: "/tmp",
      toolCall: { id: "spawn_1", name: "spawn_agent" },
      agent: {
        async spawnSubAgent(input, _cwd, options) {
          return {
            agentId: "child_1",
            runId: "run_1",
            nickname: "Ada",
            agentName: options.profile.name,
            profileSource: options.profile.source,
            category: options.category,
            route: {
              category: "review",
              providerId: "openai",
              model: "gpt-5.5",
              thinkingLevel: "high",
              inherited: false,
            },
            status: "queued",
            task: typeof input === "string" ? input : "inspect",
            summary: "",
            toolNotes: [],
            createdAt: 1,
            updatedAt: 1,
          };
        },
      },
    };
    const result = await spawnTool.execute(
      { message: "inspect", category: "review" },
      ctx,
    );
    const metadata = result.metadata as { subagents?: Array<{ route?: unknown }> } | undefined;

    expect(result.content).toContain("Spawned Ada (default/review)");
    expect(result.content).toContain("route: openai:gpt-5.5 (thinking: high)");
    expect(metadata?.subagents?.[0]?.route).toMatchObject({
      providerId: "openai",
      model: "gpt-5.5",
      thinkingLevel: "high",
    });
  });

  it("spawns a Codex-style child thread with a random nickname and waits for completion", async () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
    const agent = new Agent({
      provider: providerFromTurns([
        [{ type: "text", content: "child summary" }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [],
    });

    const spawned = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "spawn_1",
    });
    const completed = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 500 });

    expect(spawned.agentId).toBeTruthy();
    expect(spawned.nickname).toBeTruthy();
    expect(spawned.nickname).not.toBe(profile.name);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      agentId: spawned.agentId,
      nickname: spawned.nickname,
      status: "completed",
      summary: "child summary",
    });
  });

  it("sends follow-up input to the same child thread after completion", async () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
    const agent = new Agent({
      provider: providerFromTurns([
        [{ type: "text", content: "first" }, { type: "done" }],
        [{ type: "text", content: "second" }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [],
    });

    const spawned = await agent.spawnSubAgent("first task", "/tmp", {
      profile,
      parentToolCallId: "spawn_1",
    });
    await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 500 });
    const followup = await agent.sendSubAgentInput(spawned.agentId, "second task", "/tmp", {
      parentToolCallId: "send_1",
    });
    const completed = await agent.waitSubAgents({ agentIds: [followup.agentId], timeoutMs: 500 });

    expect(followup.agentId).toBe(spawned.agentId);
    expect(followup.nickname).toBe(spawned.nickname);
    expect(completed[0].summary).toBe("second");
  });

  it("keeps tool-call preamble text out of the completed child summary", async () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
    const readTool: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      effect: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "tool result" };
      },
    };
    const agent = new Agent({
      provider: providerFromTurns([
        [
          { type: "text", content: "Let me inspect files first." },
          { type: "tool_call", id: "read_1", name: "read", arguments: "{}", isStart: true, isEnd: true },
          { type: "done" },
        ],
        [{ type: "text", content: "Final summary only." }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool],
    });

    const spawned = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "spawn_1",
    });
    const completed = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 500 });

    expect(completed[0].summary).toBe("Final summary only.");
  });

  it("re-runs the final summary when the last tool-free turn ends mid-thought", async () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
    const readTool: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      effect: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "tool result", metadata: { kind: "read", path: "/tmp/x" } };
      },
    };
    const agent = new Agent({
      provider: providerFromTurns([
        [
          { type: "tool_call", id: "read_1", name: "read", arguments: "{}", isStart: true, isEnd: true },
          { type: "done" },
        ],
        // Streamed text *looks* clean but is mid-thought narration, not a real answer.
        [{ type: "text", content: "Let me try reading the problematic files with small limits:" }, { type: "done" }],
        [{ type: "text", content: "Project is a collection of HTML demos." }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool],
    });

    const spawned = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "spawn_1",
    });
    const completed = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 500 });

    expect(completed[0].summary).toBe("Project is a collection of HTML demos.");
  });

  it("re-runs the final summary when the streamed text was only protocol artifacts", async () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
    const readTool: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      effect: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "tool result", metadata: { kind: "read", path: "/tmp/x" } };
      },
    };
    const agent = new Agent({
      provider: providerFromTurns([
        [
          { type: "tool_call", id: "read_1", name: "read", arguments: "{}", isStart: true, isEnd: true },
          { type: "done" },
        ],
        // Streamed text is *only* a protocol artifact — must not be accepted as the summary.
        [{ type: "text", content: "<｜｜DSML｜｜tool_calls>" }, { type: "done" }],
        [{ type: "text", content: "Clean recovered summary." }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool],
    });

    const spawned = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "spawn_1",
    });
    const completed = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 500 });

    expect(completed[0].summary).toBe("Clean recovered summary.");
  });

  it("keeps subagent tool notes free of raw tool-result content", async () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
    const readTool: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      effect: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: "<!DOCTYPE html>\n<html><body>...</body></html>",
          metadata: { kind: "read", path: "/tmp/page.html" },
        };
      },
    };
    const agent = new Agent({
      provider: providerFromTurns([
        [
          { type: "tool_call", id: "read_1", name: "read", arguments: "{}", isStart: true, isEnd: true },
          { type: "done" },
        ],
        [{ type: "text", content: "Done." }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool],
    });

    const spawned = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "spawn_1",
    });
    const completed = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 500 });

    expect(completed[0].toolNotes.join("\n")).not.toContain("<!DOCTYPE");
    expect(completed[0].toolNotes.some((note) => note.includes("/tmp/page.html"))).toBe(true);
  });

  it("runs a no-tool final summary turn when a child only produced tool output", async () => {
    const profile = findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
    const readTool: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      effect: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "tool result" };
      },
    };
    const agent = new Agent({
      provider: providerFromTurns([
        [
          { type: "text", content: "Let me inspect files first." },
          { type: "tool_call", id: "read_1", name: "read", arguments: "{}", isStart: true, isEnd: true },
          { type: "done" },
        ],
        [{ type: "done" }],
        [{ type: "text", content: "Recovered final summary." }, { type: "done" }],
      ]),
      model: "gpt-4o",
      tools: [readTool],
    });

    const spawned = await agent.spawnSubAgent("inspect", "/tmp", {
      profile,
      parentToolCallId: "spawn_1",
    });
    const completed = await agent.waitSubAgents({ agentIds: [spawned.agentId], timeoutMs: 500 });

    expect(completed[0].summary).toBe("Recovered final summary.");
  });
});

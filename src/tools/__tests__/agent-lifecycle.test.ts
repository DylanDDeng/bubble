import { describe, expect, it } from "vitest";
import { createAllTools } from "../index.js";
import { createSpawnAgentTool, createWaitAgentTool } from "../agent-lifecycle.js";
import type { SubagentThreadSnapshot } from "../../agent/subagent-control.js";

function snapshot(overrides: Partial<SubagentThreadSnapshot> = {}): SubagentThreadSnapshot {
  return {
    agentId: "agent_1",
    runId: "run_1",
    nickname: "Ada",
    agentName: "explorer",
    profileSource: "builtin",
    status: "completed",
    task: "inspect",
    summary: "done",
    toolNotes: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("agent lifecycle tools", () => {
  it("registers lifecycle tools instead of removed legacy delegation tools", () => {
    const names = createAllTools("/tmp").map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(["spawn_agent", "wait_agent", "send_input", "close_agent"]));
    expect(names).not.toContain("subagent");
    expect(names).not.toContain("task");
  });

  it("spawn_agent defaults to the default role and returns the random nickname", async () => {
    const tool = createSpawnAgentTool();
    const result = await tool.execute(
      { message: "inspect" },
      {
        cwd: "/tmp",
        toolCall: { id: "spawn_1", name: "spawn_agent" },
        agent: {
          runSubtask: async () => ({ content: "unused" }),
          spawnSubAgent: async (_input, _cwd, options) => {
            expect(options.profile.name).toBe("default");
            expect(options.parentToolCallId).toBe("spawn_1");
            return snapshot({ status: "running" });
          },
        },
      },
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("Spawned Ada (explorer)");
    expect(result.content).toContain("agent_id: agent_1");
    expect(result.metadata?.subagents).toEqual([
      expect.objectContaining({ nickname: "Ada", agentName: "explorer" }),
    ]);
  });

  it("wait_agent returns timeout when no child completed", async () => {
    const tool = createWaitAgentTool();
    const result = await tool.execute(
      { timeout_ms: 10 },
      {
        cwd: "/tmp",
        agent: {
          runSubtask: async () => ({ content: "unused" }),
          waitSubAgents: async () => [],
        },
      },
    );

    expect(result.status).toBe("timeout");
    expect(result.content).toContain("No subagents reached");
  });

  it("wait_agent returns running snapshots on timeout so callers keep waiting", async () => {
    const tool = createWaitAgentTool();
    const result = await tool.execute(
      { timeout_ms: 10 },
      {
        cwd: "/tmp",
        agent: {
          runSubtask: async () => ({ content: "unused" }),
          waitSubAgents: async () => [
            snapshot({ status: "running", summary: "", toolNotes: ["read: inspected index.html"] }),
          ],
        },
      },
    );

    expect(result.status).toBe("timeout");
    expect(result.content).toContain("still running");
    expect(result.content).toContain("Ada (explorer)");
    expect(result.content).toContain("read: inspected index.html");
    expect(result.metadata?.subagents).toEqual([
      expect.objectContaining({ status: "running", nickname: "Ada" }),
    ]);
  });
});

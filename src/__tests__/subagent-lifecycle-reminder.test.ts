import { describe, expect, it } from "vitest";
import { buildSubagentLifecycleReminder } from "../agent/subagent-lifecycle-reminder.js";
import type { SubagentThreadSnapshot } from "../agent/subagent-control.js";
import type { ToolResult } from "../types.js";

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

function result(subagents: Array<Record<string, unknown>>): ToolResult {
  return {
    content: "subagents",
    metadata: {
      kind: "subagent",
      subagents,
    },
  };
}

describe("subagent lifecycle reminder", () => {
  it("counts unique agent ids instead of repeated lifecycle tool results", () => {
    const reminder = buildSubagentLifecycleReminder([], [
      result([{ subAgentId: "agent_1", nickname: "Ada", agentName: "explorer", status: "queued" }]),
      result([{ subAgentId: "agent_1", nickname: "Ada", agentName: "explorer", status: "completed" }]),
      result([{ subAgentId: "agent_2", nickname: "Grace", agentName: "explorer", status: "completed" }]),
    ]);

    expect(reminder).toContain("Unique subagents currently tracked: 2.");
    expect(reminder).toContain("completed=2");
    expect(reminder).toContain("do not count repeated spawn_agent/wait_agent tool calls");
  });

  it("prefers current runtime snapshots over stale spawn metadata", () => {
    const reminder = buildSubagentLifecycleReminder([
      snapshot({
        agentId: "agent_1",
        nickname: "Ken",
        agentName: "explorer",
        category: "deep",
        status: "completed",
        summary: "Deep analysis finished.",
      }),
    ], [
      result([{ subAgentId: "agent_1", nickname: "Ken", agentName: "explorer", category: "deep", status: "queued" }]),
    ]);

    expect(reminder).toContain("Ken (explorer/deep) agent_id=agent_1 status=completed");
    expect(reminder).toContain("Do not describe a subagent as running");
    expect(reminder).not.toContain("status=queued");
  });
});

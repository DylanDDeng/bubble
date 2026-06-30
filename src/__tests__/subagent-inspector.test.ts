import { describe, expect, it } from "vitest";
import {
  collectSubagentGroups,
  latestSubagentNote,
  sortSubagents,
  subagentDescriptor,
  subagentSummary,
  type SubagentDisplay,
} from "../tui-ink/subagent-view.js";
import type { DisplayMessage, DisplayToolCall } from "../tui-ink/display-history.js";

function member(over: Partial<SubagentDisplay>): SubagentDisplay {
  return { subAgentId: "m", nickname: "Ada", status: "running", ...over };
}

function subagentToolCall(id: string, members: SubagentDisplay[], extra: Record<string, unknown> = {}, args: Record<string, any> = {}): DisplayToolCall {
  return {
    id,
    name: "spawn_agent",
    args,
    metadata: { kind: "subagent", subagents: members, ...extra } as any,
  };
}

describe("collectSubagentGroups", () => {
  it("makes one 'single' group per spawn_agent, labeled by the member", () => {
    const msg: DisplayMessage = {
      role: "assistant",
      content: "",
      toolCalls: [subagentToolCall("t1", [member({ nickname: "Grace" })])],
    };
    const groups = collectSubagentGroups([msg], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("single");
    expect(groups[0].label).toBe("Grace");
    expect(groups[0].members).toHaveLength(1);
  });

  it("makes a 'team'/'batch' group from mode, labeled by the tool description", () => {
    const team: DisplayMessage = {
      role: "assistant",
      content: "",
      toolCalls: [subagentToolCall("t2", [member({ subAgentId: "a" }), member({ subAgentId: "b" })], { mode: "team" }, { description: "review modules" })],
    };
    const batch: DisplayMessage = {
      role: "assistant",
      content: "",
      toolCalls: [subagentToolCall("t3", [member({ subAgentId: "c" })], { mode: "batch" }, { description: "scout" })],
    };
    const groups = collectSubagentGroups([team, batch], []);
    expect(groups.map((g) => g.kind)).toEqual(["team", "batch"]);
    expect(groups[0].label).toBe("review modules");
    expect(groups[0].members).toHaveLength(2);
  });

  it("collects tool calls from message.parts as well as message.toolCalls", () => {
    const msg: DisplayMessage = {
      role: "assistant",
      content: "",
      parts: [{ type: "tools", toolCalls: [subagentToolCall("p1", [member({})])] }],
    };
    expect(collectSubagentGroups([msg], [])).toHaveLength(1);
  });

  it("dedupes by tool id (streaming overrides committed) and skips empty/non-subagent calls", () => {
    const committed: DisplayMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        subagentToolCall("dup", [member({ status: "running" })]),
        { id: "x", name: "read", args: {}, metadata: { kind: "read" } as any }, // non-subagent
        subagentToolCall("empty", []), // no members → skipped
      ],
    };
    const streaming: DisplayToolCall[] = [subagentToolCall("dup", [member({ status: "completed" })])];
    const groups = collectSubagentGroups([committed], streaming);
    expect(groups).toHaveLength(1);
    expect(groups[0].members[0].status).toBe("completed"); // freshest won
  });

  it("collapses a single agent's many lifecycle echoes (spawn + wait + ...) into ONE member", () => {
    // The real bug: one spawned subagent, echoed by spawn_agent (stale running)
    // and two wait_agent calls (one timed-out running, one completed) — must
    // show ONE subagent, completed, not three.
    const spawn: DisplayToolCall = { id: "spawn1", name: "spawn_agent", args: {}, metadata: { kind: "subagent", mode: "lifecycle", subagents: [member({ subAgentId: "A", status: "queued", toolNotes: [] })] } as any };
    const wait1: DisplayToolCall = { id: "wait1", name: "wait_agent", args: {}, metadata: { kind: "subagent", mode: "lifecycle", subagents: [member({ subAgentId: "A", status: "running", toolNotes: ["read x"] })] } as any };
    const wait2: DisplayToolCall = { id: "wait2", name: "wait_agent", args: {}, metadata: { kind: "subagent", mode: "lifecycle", subagents: [member({ subAgentId: "A", status: "completed", toolNotes: ["read x", "grep y"], summary: "done" })] } as any };
    const msg: DisplayMessage = { role: "assistant", content: "", toolCalls: [spawn, wait1, wait2] };
    const groups = collectSubagentGroups([msg], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("single");
    expect(groups[0].members).toHaveLength(1);
    expect(groups[0].members[0].status).toBe("completed"); // freshest snapshot
  });

  it("does not double-count team members echoed by a later wait_agent", () => {
    const team: DisplayToolCall = { id: "team1", name: "agent_team", args: { description: "review" }, metadata: { kind: "subagent", mode: "team", subagents: [member({ subAgentId: "a", status: "running" }), member({ subAgentId: "b", status: "running" })] } as any };
    const wait: DisplayToolCall = { id: "w", name: "wait_agent", args: {}, metadata: { kind: "subagent", mode: "lifecycle", subagents: [member({ subAgentId: "a", status: "completed" }), member({ subAgentId: "b", status: "completed" })] } as any };
    const groups = collectSubagentGroups([{ role: "assistant", content: "", toolCalls: [team, wait] }], []);
    expect(groups).toHaveLength(1); // one team group, no extra singles
    expect(groups[0].kind).toBe("team");
    expect(groups[0].members.map((m) => m.status)).toEqual(["completed", "completed"]); // freshest
  });
});

describe("subagent-view helpers", () => {
  it("subagentSummary counts statuses in a stable order", () => {
    const summary = subagentSummary([
      member({ status: "completed" }),
      member({ status: "running" }),
      member({ status: "completed" }),
    ]);
    expect(summary).toBe("1 running  2 completed");
  });

  it("sortSubagents puts active/problem states before completed", () => {
    const order = sortSubagents([
      member({ subAgentId: "1", status: "completed" }),
      member({ subAgentId: "2", status: "running" }),
      member({ subAgentId: "3", status: "failed" }),
    ]).map((m) => m.status);
    expect(order).toEqual(["running", "failed", "completed"]);
  });

  it("subagentDescriptor includes the model route when present", () => {
    const d = subagentDescriptor(member({ agentName: "explorer", route: { providerId: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "low" } }));
    expect(d).toContain("explorer");
    expect(d).toContain("claude-haiku-4-5");
  });

  it("latestSubagentNote prefers error, then the last tool note", () => {
    expect(latestSubagentNote(member({ toolNotes: ["read a", "grep b: 3 matches"] }))).toBe("grep b: 3 matches");
    expect(latestSubagentNote(member({ toolNotes: ["read a"], error: "boom" }))).toBe("boom");
  });
});

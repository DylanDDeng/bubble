import { describe, expect, it } from "vitest";
import {
  accumulateLiveSubagentUpdate,
  collectSubagentGroups,
  mergeToolMetadata,
  pruneSettledLiveSubagentTools,
} from "../tui-ink/subagent-view.js";
import type { DisplayMessage, DisplayToolCall } from "../tui-ink/display-history.js";
import type { ToolResultMetadata } from "../types.js";

function childUpdateMetadata(subAgentId: string, status: string): ToolResultMetadata {
  return {
    kind: "subagent",
    runId: "run-1",
    subagents: [{ subAgentId, nickname: `nick-${subAgentId}`, status, task: `task ${subAgentId}` }],
  };
}

describe("live subagent trace accumulation (cross-round updates)", () => {
  it("absorbs updates whose launching tool call left the streaming round, grouped as a workflow", () => {
    const map = new Map<string, DisplayToolCall>();

    // Round N+1: wait_workflow blocks; children report against the settled
    // run_workflow call id. Each update carries ONE member snapshot.
    expect(accumulateLiveSubagentUpdate(map, { id: "wf_call", name: "run_workflow", metadata: childUpdateMetadata("a", "running") })).toBe(true);
    expect(accumulateLiveSubagentUpdate(map, { id: "wf_call", name: "run_workflow", metadata: childUpdateMetadata("b", "running") })).toBe(true);
    expect(accumulateLiveSubagentUpdate(map, { id: "wf_call", name: "run_workflow", metadata: childUpdateMetadata("a", "completed") })).toBe(true);

    // Settled transcript: the run_workflow result itself carries no members.
    const messages: DisplayMessage[] = [{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "wf_call", name: "run_workflow", args: { title: "audit team" }, metadata: { kind: "subagent", mode: "workflow", runId: "run-1" } }],
    } as DisplayMessage];

    const groups = collectSubagentGroups(messages, [...map.values()]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("workflow");
    expect(groups[0].members).toHaveLength(2);
    const a = groups[0].members.find((m) => m.subAgentId === "a");
    expect(a?.status).toBe("completed");
  });

  it("ignores non-subagent updates", () => {
    const map = new Map<string, DisplayToolCall>();
    expect(accumulateLiveSubagentUpdate(map, { id: "x", name: "bash", metadata: { kind: "shell" } })).toBe(false);
    expect(accumulateLiveSubagentUpdate(map, { id: "x", name: "bash" })).toBe(false);
    expect(map.size).toBe(0);
  });

  it("later wait_workflow result claims the members; the stale live group drops out", () => {
    const map = new Map<string, DisplayToolCall>();
    accumulateLiveSubagentUpdate(map, { id: "wf_call", name: "run_workflow", metadata: childUpdateMetadata("a", "running") });

    // wait_workflow settles with the authoritative full member list.
    const messages: DisplayMessage[] = [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "wait_call",
        name: "wait_workflow",
        args: { run_id: "run-1" },
        metadata: {
          kind: "subagent",
          mode: "workflow",
          subagents: [
            { subAgentId: "a", nickname: "nick-a", status: "completed", task: "task a" },
            { subAgentId: "b", nickname: "nick-b", status: "completed", task: "task b" },
          ],
        },
      }],
    } as DisplayMessage];

    const groups = collectSubagentGroups(messages, [...map.values()]);
    // One group only — the accumulator's echo must not produce an empty twin.
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
    // Freshest wins: the completed snapshot beats the stale running one.
    expect(groups[0].members.find((m) => m.subAgentId === "a")?.status).toBe("completed");
  });

  it("spawn_agent children absorbed cross-round render as single groups", () => {
    const map = new Map<string, DisplayToolCall>();
    accumulateLiveSubagentUpdate(map, { id: "spawn_call", name: "spawn_agent", metadata: childUpdateMetadata("c", "running") });
    const groups = collectSubagentGroups([], [...map.values()]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("single");
    expect(groups[0].members[0]?.subAgentId).toBe("c");
  });

  it("prunes entries whose members all reached a final status, keeps live ones", () => {
    const map = new Map<string, DisplayToolCall>();
    accumulateLiveSubagentUpdate(map, { id: "done_wf", name: "run_workflow", metadata: childUpdateMetadata("a", "completed") });
    accumulateLiveSubagentUpdate(map, { id: "done_wf", name: "run_workflow", metadata: childUpdateMetadata("b", "failed") });
    accumulateLiveSubagentUpdate(map, { id: "live_wf", name: "run_workflow", metadata: childUpdateMetadata("c", "completed") });
    accumulateLiveSubagentUpdate(map, { id: "live_wf", name: "run_workflow", metadata: childUpdateMetadata("d", "running") });

    expect(pruneSettledLiveSubagentTools(map)).toBe(true);
    expect([...map.keys()]).toEqual(["live_wf"]);
    // No change on a second pass — callers key their version bump off this.
    expect(pruneSettledLiveSubagentTools(map)).toBe(false);
  });

  it("mergeToolMetadata accumulates member snapshots by subAgentId", () => {
    const merged = mergeToolMetadata(childUpdateMetadata("a", "running"), childUpdateMetadata("b", "running"));
    expect(Array.isArray(merged?.subagents) && merged!.subagents.length).toBe(2);
    const again = mergeToolMetadata(merged, childUpdateMetadata("a", "completed"));
    expect(Array.isArray(again?.subagents) && again!.subagents.length).toBe(2);
  });
});

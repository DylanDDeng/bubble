import { describe, expect, it } from "vitest";
import {
  applySubagentUpdateToMessages,
  collectSubagentGroups,
  mergeToolMetadata,
} from "../tui/model/subagent-view.js";
import type { DisplayMessage, DisplayToolCall } from "../tui/model/display-history.js";
import type { ToolResultMetadata } from "../types.js";

function childUpdateMetadata(subAgentId: string, status: string): ToolResultMetadata {
  return {
    kind: "subagent",
    runId: "run-1",
    subagents: [{ subAgentId, nickname: `nick-${subAgentId}`, status, task: `task ${subAgentId}` }],
  };
}

function toolsOf(message: DisplayMessage): DisplayToolCall[] {
  return [
    ...(message.toolCalls ?? []),
    ...(message.parts ?? []).flatMap((part) => part.type === "tools" ? part.toolCalls : []),
  ];
}

function membersOf(tool: DisplayToolCall | undefined): Array<Record<string, unknown>> {
  return Array.isArray(tool?.metadata?.subagents)
    ? tool!.metadata!.subagents.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    : [];
}

describe("cross-round subagent updates land on the settled launch row", () => {
  it("absorbs workflow children spawned after run_workflow committed, grouped as a workflow", () => {
    // Settled transcript: the run_workflow result itself carries no members.
    let messages: DisplayMessage[] = [{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "wf_call", name: "run_workflow", args: { title: "audit team" }, metadata: { kind: "subagent", mode: "workflow", runId: "run-1" } }],
    } as DisplayMessage];

    // Round N+1: wait_workflow blocks; children report against the settled
    // run_workflow call id. Each update carries ONE member snapshot.
    for (const update of [childUpdateMetadata("a", "running"), childUpdateMetadata("b", "running"), childUpdateMetadata("a", "completed")]) {
      messages = applySubagentUpdateToMessages(messages, { id: "wf_call", name: "run_workflow", metadata: update });
    }

    const launch = toolsOf(messages[0]!).find((tool) => tool.id === "wf_call");
    expect(launch?.metadata?.mode).toBe("workflow");
    expect(membersOf(launch).map((m) => `${m.subAgentId}:${m.status}`)).toEqual(["a:completed", "b:running"]);

    // The inspector reads the same transcript row: one workflow group, no twin.
    const groups = collectSubagentGroups(messages, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("workflow");
    expect(groups[0].members.map((m) => m.subAgentId).sort()).toEqual(["a", "b"]);
  });

  it("marks a spawned child failed on its launch row and syncs later echoes", () => {
    const spawnMember = { subAgentId: "c", nickname: "Jean", status: "queued", task: "inspect" };
    let messages: DisplayMessage[] = [{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "spawn_call", name: "spawn_agent", args: {}, metadata: { kind: "subagent", mode: "lifecycle", subagents: [spawnMember] } }],
    } as DisplayMessage];

    messages = applySubagentUpdateToMessages(messages, {
      id: "spawn_call",
      name: "spawn_agent",
      metadata: { kind: "subagent", subagents: [{ ...spawnMember, status: "failed", error: "Provider rejected a request parameter." }] },
    });

    const launch = toolsOf(messages[0]!)[0];
    expect(membersOf(launch)[0]).toMatchObject({ subAgentId: "c", status: "failed", error: "Provider rejected a request parameter." });
    const groups = collectSubagentGroups(messages, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("single");
    expect(groups[0].members[0]?.status).toBe("failed");
  });

  it("returns the same array when nothing matches or the update is not a subagent update", () => {
    const messages: DisplayMessage[] = [{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "bash_1", name: "bash", args: {}, metadata: { kind: "shell" } }],
    } as DisplayMessage];
    expect(applySubagentUpdateToMessages(messages, { id: "bash_1", name: "bash", metadata: { kind: "shell" } })).toBe(messages);
    expect(applySubagentUpdateToMessages(messages, { id: "bash_1", name: "bash" })).toBe(messages);
    // After /clear the launch row is gone: the update is dropped, never re-created.
    expect(applySubagentUpdateToMessages(messages, { id: "gone", name: "spawn_agent", metadata: childUpdateMetadata("z", "running") })).toBe(messages);
  });

  it("this round's launches come from the streaming accumulator until they commit", () => {
    const streaming: DisplayToolCall[] = [{
      id: "spawn_live",
      name: "spawn_agent",
      args: {},
      metadata: childUpdateMetadata("d", "running"),
    }];
    const groups = collectSubagentGroups([], streaming);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("single");
    expect(groups[0].members[0]?.subAgentId).toBe("d");
  });

  it("later wait_workflow result claims the members without producing an empty twin", () => {
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

    const groups = collectSubagentGroups(messages, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });

  it("mergeToolMetadata accumulates member snapshots by subAgentId", () => {
    const merged = mergeToolMetadata(childUpdateMetadata("a", "running"), childUpdateMetadata("b", "running"));
    expect(Array.isArray(merged?.subagents) && merged!.subagents.length).toBe(2);
    const again = mergeToolMetadata(merged, childUpdateMetadata("a", "completed"));
    expect(Array.isArray(again?.subagents) && again!.subagents.length).toBe(2);
  });
});

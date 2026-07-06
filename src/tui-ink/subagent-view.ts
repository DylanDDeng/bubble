/**
 * Shared subagent view-model + presentation helpers, used by both the inline
 * Subagents block (message-list.tsx) and the full-screen inspector
 * (subagent-inspector.tsx). Pure functions only — no React.
 */

import { formatSubagentRoute, type SubagentRouteLike } from "../agent/subagent-route-format.js";
import type { Theme } from "./theme.js";
import type { DisplayMessage, DisplayToolCall } from "./display-history.js";

export interface SubagentDisplay {
  subAgentId?: string;
  agentName?: string;
  nickname?: string;
  status?: string;
  category?: string;
  route?: SubagentRouteLike;
  profileSource?: string;
  task?: string;
  summary?: string;
  toolNotes?: string[];
  error?: string;
}

export function latestSubagentNote(subagent: SubagentDisplay): string {
  const note = subagent.error
    || subagent.toolNotes?.filter(Boolean).at(-1)
    || subagent.summary
    || subagent.task
    || "";
  return note.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

export function subagentLabel(subagent: SubagentDisplay): string {
  return subagent.nickname ?? subagent.agentName ?? "subagent";
}

export function subagentRole(subagent: SubagentDisplay): string {
  return [subagent.agentName, subagent.category ? `/${subagent.category}` : ""].join("") || "default";
}

export function subagentDescriptor(subagent: SubagentDisplay, includeThinking = false): string {
  const route = formatSubagentRoute(subagent.route, { includeThinking });
  const role = subagentRole(subagent);
  return route ? `${role} @ ${route}` : role;
}

export function subagentStatusColor(status: string | undefined, theme: Theme): string {
  if (status === "completed") return theme.success;
  if (status === "failed" || status === "blocked" || status === "cancelled") return theme.error;
  if (status === "queued") return theme.muted;
  return theme.toolPending;
}

export function subagentSummary(subagents: SubagentDisplay[]): string {
  if (subagents.length === 0) return "no subagents";
  const counts = new Map<string, number>();
  for (const subagent of subagents) {
    const status = subagent.status ?? "running";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order = ["running", "queued", "completed", "blocked", "failed", "cancelled"];
  return order
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status}`)
    .join("  ");
}

export function sortSubagents(subagents: SubagentDisplay[]): SubagentDisplay[] {
  const rank: Record<string, number> = {
    running: 0,
    blocked: 1,
    failed: 2,
    queued: 3,
    cancelled: 4,
    completed: 5,
  };
  return [...subagents].sort((a, b) => (rank[a.status ?? "running"] ?? 9) - (rank[b.status ?? "running"] ?? 9));
}

/** A spawn_agent (one member) or a run_workflow (a group of members). The
 * "team"/"batch" kinds survive only to render transcripts recorded before
 * those tools were removed (2026-07-06). */
export interface SubagentGroup {
  id: string;
  kind: "single" | "team" | "batch" | "workflow";
  label: string;
  members: SubagentDisplay[];
}

function subagentStatusRank(status: string | undefined): number {
  if (status === "completed" || status === "failed" || status === "blocked" || status === "cancelled" || status === "closed") return 3;
  if (status === "running") return 2;
  if (status === "queued") return 1;
  return 0;
}

/** Higher = more "complete"/recent snapshot of the same subagent. */
function subagentFreshness(member: SubagentDisplay): number {
  return subagentStatusRank(member.status) * 100_000
    + (member.toolNotes?.length ?? 0) * 10
    + (member.summary ? 1 : 0);
}

function memberKey(member: SubagentDisplay): string {
  return member.subAgentId || `${member.nickname ?? ""}|${member.task ?? ""}`;
}

/**
 * Collects every spawned subagent from the live transcript + streaming tools,
 * grouped by their originating tool call, for the inspector. Pure.
 *
 * The same subagent is echoed by MULTIPLE lifecycle tool calls — its spawn_agent
 * (a stale snapshot) plus every wait_agent/list_agents that observed it (later
 * snapshots), all carrying metadata.subagents (agent-lifecycle formatLifecycleResult).
 * So we dedupe by subAgentId, keep the freshest snapshot, group team/batch members
 * by their originating tool call, and collapse a single agent's many lifecycle
 * echoes into one "single" group keyed by the agent itself.
 */
export function collectSubagentGroups(
  messages: DisplayMessage[],
  streamingTools: DisplayToolCall[],
): SubagentGroup[] {
  const toolCalls: DisplayToolCall[] = [];
  const ingest = (tcs: DisplayToolCall[] | undefined): void => {
    if (!tcs) return;
    for (const tc of tcs) if (tc.metadata?.kind === "subagent") toolCalls.push(tc);
  };
  for (const message of messages) {
    ingest(message.toolCalls);
    if (message.parts) {
      for (const part of message.parts) {
        if (part.type === "tools") ingest(part.toolCalls);
      }
    }
  }
  ingest(streamingTools);

  const freshest = new Map<string, SubagentDisplay>();
  const memberToGroup = new Map<string, string>();
  const groups = new Map<string, { kind: SubagentGroup["kind"]; label: string; memberKeys: string[]; order: number }>();
  let order = 0;

  for (const tc of toolCalls) {
    const rawMembers = Array.isArray(tc.metadata?.subagents) ? tc.metadata!.subagents : [];
    const members = rawMembers.filter((m): m is SubagentDisplay => typeof m === "object" && m !== null);
    if (members.length === 0) continue;

    // Track the freshest snapshot seen for each subagent.
    for (const m of members) {
      const key = memberKey(m);
      const prev = freshest.get(key);
      if (!prev || subagentFreshness(m) >= subagentFreshness(prev)) freshest.set(key, m);
    }

    const mode = (tc.metadata as Record<string, unknown>).mode;
    if (mode === "team" || mode === "batch" || mode === "workflow") {
      // A team/batch/workflow tool call is the canonical group for its members.
      const groupKey = tc.id;
      if (!groups.has(groupKey)) {
        const description = typeof tc.args?.description === "string" ? tc.args.description.trim()
          : typeof tc.args?.title === "string" ? tc.args.title.trim() : "";
        groups.set(groupKey, { kind: mode, label: description || mode, memberKeys: [], order: order++ });
      }
      const group = groups.get(groupKey)!;
      for (const m of members) {
        const key = memberKey(m);
        if (!memberToGroup.has(key)) {
          memberToGroup.set(key, groupKey);
          group.memberKeys.push(key);
        }
      }
    } else {
      // Lifecycle echo (spawn/wait/list/...): one "single" group per agent,
      // collapsing all its echoes; skip any already claimed by a team/batch.
      for (const m of members) {
        const key = memberKey(m);
        if (memberToGroup.has(key)) continue;
        const groupKey = `single:${key}`;
        memberToGroup.set(key, groupKey);
        groups.set(groupKey, { kind: "single", label: m.nickname ?? m.task ?? "subagent", memberKeys: [key], order: order++ });
      }
    }
  }

  return [...groups.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id, g]) => ({
      id,
      kind: g.kind,
      label: g.label,
      members: g.memberKeys.map((k) => freshest.get(k)).filter((m): m is SubagentDisplay => !!m),
    }));
}

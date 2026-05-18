import type { SubagentThreadSnapshot } from "./subagent-control.js";
import type { ToolResult } from "../types.js";

interface LifecycleSubagent {
  agentId: string;
  nickname?: string;
  agentName?: string;
  category?: string;
  status?: string;
  summary?: string;
  error?: string;
}

const STATUS_ORDER = ["queued", "running", "completed", "blocked", "failed", "cancelled", "closed"];

export function buildSubagentLifecycleReminder(
  snapshots: SubagentThreadSnapshot[],
  toolResults: ToolResult[],
): string | undefined {
  const subagents = collectUniqueSubagents(snapshots, toolResults);
  if (subagents.length === 0) return undefined;

  const counts = statusCounts(subagents);
  const lines = [
    "Subagent lifecycle truth:",
    `- Unique subagents currently tracked: ${subagents.length}.`,
    `- Status counts: ${formatStatusCounts(counts)}.`,
    "- Agents:",
    ...subagents.map(formatSubagentLine),
    "- Count unique agent_id values only; do not count repeated spawn_agent/wait_agent tool calls or repeated UI Subagents blocks as additional subagents.",
    "- Do not describe a subagent as running or still working if its status above is completed, failed, blocked, cancelled, or closed.",
    "- After spawn_agent, call wait_agent before user-facing progress narration unless you are doing concrete non-overlapping local work.",
    "- When writing a synthesis, use the exact unique subagent count and statuses above.",
  ];
  return lines.join("\n");
}

function collectUniqueSubagents(
  snapshots: SubagentThreadSnapshot[],
  toolResults: ToolResult[],
): LifecycleSubagent[] {
  const byId = new Map<string, LifecycleSubagent>();
  for (const result of toolResults) {
    for (const subagent of subagentsFromMetadata(result.metadata)) {
      byId.set(subagent.agentId, {
        ...byId.get(subagent.agentId),
        ...subagent,
      });
    }
  }
  for (const snapshot of snapshots) {
    byId.set(snapshot.agentId, {
      ...byId.get(snapshot.agentId),
      agentId: snapshot.agentId,
      nickname: snapshot.nickname,
      agentName: snapshot.agentName,
      category: snapshot.category,
      status: snapshot.status,
      summary: snapshot.summary,
      error: snapshot.error,
    });
  }
  return [...byId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function subagentsFromMetadata(metadata: ToolResult["metadata"]): LifecycleSubagent[] {
  const raw = metadata?.subagents;
  if (!Array.isArray(raw)) return [];
  const out: LifecycleSubagent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const agentId = stringField(record.subAgentId) ?? stringField(record.agentId);
    if (!agentId) continue;
    out.push({
      agentId,
      nickname: stringField(record.nickname),
      agentName: stringField(record.agentName),
      category: stringField(record.category),
      status: stringField(record.status),
      summary: stringField(record.summary),
      error: stringField(record.error),
    });
  }
  return out;
}

function statusCounts(subagents: LifecycleSubagent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const subagent of subagents) {
    const status = subagent.status || "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return counts;
}

function formatStatusCounts(counts: Map<string, number>): string {
  const known = STATUS_ORDER
    .filter((status) => counts.has(status))
    .map((status) => `${status}=${counts.get(status)}`);
  const extra = [...counts.keys()]
    .filter((status) => !STATUS_ORDER.includes(status))
    .sort()
    .map((status) => `${status}=${counts.get(status)}`);
  return [...known, ...extra].join(", ") || "none";
}

function formatSubagentLine(subagent: LifecycleSubagent): string {
  const label = subagent.nickname || subagent.agentName || subagent.agentId;
  const role = [subagent.agentName, subagent.category ? `/${subagent.category}` : ""].join("") || "default";
  const status = subagent.status || "unknown";
  const note = subagent.error || subagent.summary;
  const suffix = note ? `; note=${truncateForReminder(oneLine(note))}` : "";
  return `  - ${label} (${role}) agent_id=${subagent.agentId} status=${status}${suffix}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateForReminder(value: string, max = 180): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

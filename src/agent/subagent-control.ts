import type { AgentProfile, AgentProfileSource, SubagentRunResult } from "./profiles.js";
import type { ResolvedSubagentRoute } from "./categories.js";
import type { AgentEvent, ContentPart, Message, ToolUpdate } from "../types.js";

export type SubagentThreadStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "closed";

export interface SubagentThreadSnapshot {
  agentId: string;
  runId: string;
  nickname: string;
  agentName: string;
  profileSource: AgentProfileSource;
  category?: string;
  route?: ResolvedSubagentRoute;
  status: SubagentThreadStatus;
  task: string;
  summary: string;
  toolNotes: string[];
  usage?: SubagentRunResult["usage"];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SubagentThreadRecord {
  agentId: string;
  runId: string;
  nickname: string;
  profile: AgentProfile;
  category?: string;
  route?: ResolvedSubagentRoute;
  parentToolCallId: string;
  parentToolName: string;
  status: SubagentThreadStatus;
  task: string;
  summary: string;
  toolNotes: string[];
  usage?: SubagentRunResult["usage"];
  error?: string;
  createdAt: number;
  updatedAt: number;
  abortController: AbortController;
  waiters: Set<() => void>;
  agent?: {
    messages: Message[];
    injectSystemReminder(content: string): void;
    run(input: string | ContentPart[], cwd: string, options?: { abortSignal?: AbortSignal }): AsyncIterable<AgentEvent>;
  };
  messages?: Message[];
  promise?: Promise<void>;
}

export interface PendingSubagentToolUpdate {
  id: string;
  name: string;
  update: ToolUpdate;
}

export function snapshotSubagentThread(record: SubagentThreadRecord): SubagentThreadSnapshot {
  return {
    agentId: record.agentId,
    runId: record.runId,
    nickname: record.nickname,
    agentName: record.profile.name,
    profileSource: record.profile.source,
    category: record.category,
    route: record.route,
    status: record.status,
    task: record.task,
    summary: record.summary,
    toolNotes: [...record.toolNotes],
    usage: record.usage,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function subagentResultFromThread(record: SubagentThreadRecord): SubagentRunResult {
  const status = record.status === "completed"
    ? "completed"
    : record.status === "blocked"
      ? "blocked"
      : record.status === "cancelled" || record.status === "closed"
        ? "cancelled"
        : "failed";
  return {
    subAgentId: record.agentId,
    agentName: record.profile.name,
    nickname: record.nickname,
    status,
    profileSource: record.profile.source,
    category: record.category,
    route: record.route,
    task: record.task,
    summary: record.summary,
    toolNotes: [...record.toolNotes],
    usage: record.usage,
    error: record.error,
  };
}

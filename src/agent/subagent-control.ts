import type { AgentProfile, AgentProfileSource, SubagentRunResult } from "./profiles.js";
import type { ResolvedSubagentRoute } from "./categories.js";
import type { SubagentWorktree } from "./worktree.js";
import type { AgentEvent, ContentPart, Message, ToolUpdate } from "../types.js";

export type SubagentThreadStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "closed";

/**
 * Why a child run ended. Drives the `resumable` flag and the guidance line
 * rendered in lifecycle tool replies (design doc §3.1) — a resume hint is
 * emitted iff the runtime judged the run resumable, never as a blanket string.
 */
export type SubagentFinalReason =
  | "completed"
  | "failed_transient"
  | "failed_fatal"
  | "rate_limited_exhausted"
  | "blocked"
  | "cancelled_interrupt"
  | "cancelled_user"
  | "cancelled_budget"
  | "cancelled_parent_abort";

export function isResumableReason(reason: SubagentFinalReason): boolean {
  switch (reason) {
    case "failed_transient":
    case "rate_limited_exhausted":
    case "cancelled_interrupt":
    case "cancelled_user":
    case "cancelled_parent_abort":
      return true;
    case "completed":
    case "failed_fatal":
    case "blocked":
    case "cancelled_budget":
      return false;
  }
}

/** Per-child token budget, fixed at dispatch time (design doc §6). */
export interface SubagentTokenCap {
  /** Soft cap: crossing it injects a wrap-up reminder into the child. */
  soft: number;
  /** Hard cap: crossing it aborts this child only. Updated at turn checks. */
  hard: number;
  /** Ledger tokens already attributed to this child when the run started. */
  baseline: number;
}

export interface SubagentThreadSnapshot {
  agentId: string;
  runId: string;
  nickname: string;
  agentName: string;
  profileSource: AgentProfileSource;
  category?: string;
  route?: ResolvedSubagentRoute;
  status: SubagentThreadStatus;
  finalReason?: SubagentFinalReason;
  resumable?: boolean;
  task: string;
  summary: string;
  toolNotes: string[];
  usage?: SubagentRunResult["usage"];
  error?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  /** 1-based position in the scheduler queue while status is "queued". */
  queuePosition?: number;
  tokenCap?: SubagentTokenCap;
  /** Present for write_worktree children: where the isolated checkout lives. */
  worktree?: SubagentWorktree;
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
  finalReason?: SubagentFinalReason;
  task: string;
  summary: string;
  toolNotes: string[];
  usage?: SubagentRunResult["usage"];
  error?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  tokenCap?: SubagentTokenCap;
  worktree?: SubagentWorktree;
  /** True for agents spawned inside a run_workflow: kept out of list_agents /
   * wait_agent and not persisted (design v2 appendix; option C). */
  workflowInternal?: boolean;
  abortController: AbortController;
  waiters: Set<() => void>;
  agent?: {
    messages: Message[];
    injectSystemReminder(content: string): void;
    run(input: string | ContentPart[], cwd: string, options?: { abortSignal?: AbortSignal; resumeWithoutInput?: boolean }): AsyncIterable<AgentEvent>;
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
    finalReason: record.finalReason,
    resumable: record.finalReason !== undefined ? isResumableReason(record.finalReason) : undefined,
    task: record.task,
    summary: record.summary,
    toolNotes: [...record.toolNotes],
    usage: record.usage,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deliveredAt: record.deliveredAt,
    tokenCap: record.tokenCap ? { ...record.tokenCap } : undefined,
    worktree: record.worktree ? { ...record.worktree } : undefined,
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

export function isFinalSubagentThreadStatus(status: SubagentThreadStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "blocked"
    || status === "cancelled"
    || status === "closed";
}

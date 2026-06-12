/**
 * Approval flow: tools that want a gating UI construct an ApprovalRequest and
 * await an ApprovalDecision from the harness (via ApprovalController).
 *
 * Mirrors Claude Code's per-tool Permission Request components in that each
 * request carries tool-typed data so the UI can render a meaningful preview.
 */

import type { PermissionCheckResult, PermissionQuery } from "../permissions/types.js";

export interface EditApprovalRequest {
  type: "edit";
  path: string;
  /** Unified patch (with context lines) to show the user. */
  diff: string;
  fileExists: boolean;
}

export interface WriteApprovalRequest {
  type: "write";
  path: string;
  /** Full pending file contents. */
  content: string;
  /** Unified patch from existing contents to pending contents. */
  diff?: string;
  fileExists: boolean;
}

export interface PatchApprovalRequest {
  type: "patch";
  /** Human-readable path summary for compact UIs. */
  path: string;
  /** All absolute paths touched by the patch. */
  paths: string[];
  files: Array<{ path: string; kind: "add" | "update" | "delete" }>;
  /** Combined unified diff for all file changes. */
  diff: string;
}

export interface BashApprovalRequest {
  type: "bash";
  command: string;
  cwd: string;
}

export interface LspApprovalRequest {
  type: "lsp";
  path: string;
  operation: string;
}

/**
 * Trust gate for project-local agent profiles (.bubble/agents). The user —
 * not the model — decides whether a repository's profile prompt may drive a
 * subagent; approvals are remembered per content hash for the session.
 */
export interface AgentProfileApprovalRequest {
  type: "agent_profile";
  /** Profile name as referenced by spawn_agent. */
  name: string;
  /** Absolute path of the profile file inside the repository. */
  path: string;
  /** Content hash; a changed file re-prompts. */
  contentHash: string;
  /** First lines of the profile prompt so the user can judge it. */
  promptPreview: string;
}

export type ApprovalRequest =
  | EditApprovalRequest
  | WriteApprovalRequest
  | PatchApprovalRequest
  | BashApprovalRequest
  | LspApprovalRequest
  | AgentProfileApprovalRequest;

export type ApprovalDecision =
  | { action: "approve"; feedback?: string }
  | { action: "reject"; feedback?: string };

export interface ApprovalController {
  /**
   * Decide whether a tool call should proceed. May consult the current
   * permission mode, configured allow/deny rules, session-level allowlists,
   * and — as a final fallback — a user-interactive UI handler.
   */
  request(req: ApprovalRequest): Promise<ApprovalDecision>;

  /**
   * Pure rule evaluation (no UI, no mode gates). Tools that silently execute
   * unless explicitly denied (e.g. Read, WebFetch) call this to honor
   * user-configured deny rules without changing the UX for the common case.
   */
  checkRules(query: PermissionQuery): PermissionCheckResult;
}

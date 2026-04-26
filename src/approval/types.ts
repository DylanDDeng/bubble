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

export type ApprovalRequest =
  | EditApprovalRequest
  | WriteApprovalRequest
  | BashApprovalRequest
  | LspApprovalRequest;

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

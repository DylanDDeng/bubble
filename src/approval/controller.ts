import type { PermissionMode } from "../types.js";
import type { BashAllowlist } from "./session-cache.js";
import type { ApprovalController, ApprovalDecision, ApprovalRequest } from "./types.js";

export interface ApprovalControllerOptions {
  /** Reads the live agent mode on each request so mode flips take effect immediately. */
  getMode: () => PermissionMode;
  /**
   * UI handler attached by the TUI on mount. Returns the user's decision from
   * an interactive dialog. When not attached (e.g. --print mode), the
   * controller falls back to rejecting in safe modes.
   */
  handlerRef: { current?: (req: ApprovalRequest) => Promise<ApprovalDecision> };
  /** Session-scoped bash command prefix allowlist. Optional. */
  bashAllowlist?: BashAllowlist;
}

/**
 * Default ApprovalController. Decision tree:
 *
 *   bypassPermissions / dontAsk  → auto-approve, no prompt
 *   acceptEdits + edit|write     → auto-approve
 *   plan                         → reject with instructions to use exit_plan_mode
 *   default / other              → delegate to UI; if no UI, reject
 *
 * Session-level allowlists (per-command prefix / per-path glob) are layered
 * in a later PR and will sit between the mode check and the UI fallback.
 */
export class PermissionAwareApprovalController implements ApprovalController {
  constructor(private readonly options: ApprovalControllerOptions) {}

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const mode = this.options.getMode();

    if (mode === "bypassPermissions" || mode === "dontAsk") {
      return { action: "approve" };
    }

    if (mode === "acceptEdits" && (req.type === "edit" || req.type === "write")) {
      return { action: "approve" };
    }

    if (mode === "plan") {
      return {
        action: "reject",
        feedback:
          "Plan mode is active. Do not call destructive tools directly — propose your changes via exit_plan_mode and wait for user approval.",
      };
    }

    // Session-scoped allowlist: let previously-approved bash prefixes through
    // without re-prompting.
    if (req.type === "bash" && this.options.bashAllowlist?.matches(req.command)) {
      return { action: "approve" };
    }

    const handler = this.options.handlerRef.current;
    if (!handler) {
      return {
        action: "reject",
        feedback: "No interactive UI is available to approve this tool call.",
      };
    }

    return handler(req);
  }
}

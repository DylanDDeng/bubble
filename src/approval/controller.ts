import { checkPermission } from "../permissions/rule.js";
import type {
  PermissionCheckResult,
  PermissionQuery,
  PermissionRuleSet,
} from "../permissions/types.js";
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
  /** Working directory — used to anchor relative path rules. */
  cwd: string;
  /**
   * Live view of configured allow/deny rules (from ~/.bubble/settings.json and
   * project-level equivalents). Called on each request so edits via
   * /permissions take effect immediately. Omit to disable rule-based gating.
   */
  getRuleSet?: () => PermissionRuleSet;
}

/**
 * Default ApprovalController. Decision tree:
 *
 *   deny rule match              → reject (applies even under bypassPermissions)
 *   bypassPermissions            → auto-approve, no prompt
 *   default + edit|write         → auto-approve
 *   plan                         → reject with instructions to use exit_plan_mode
 *   allow rule match             → auto-approve
 *   bash in session allowlist    → auto-approve
 *   bash / other                 → delegate to UI; if no UI, reject
 *
 * Deny rules sit at the top as a hard ceiling: bypassPermissions is a trust
 * escalation, not a policy override. Users who want to permit a currently-
 * denied action must edit their settings.json, not bypass checks at runtime.
 */
export class PermissionAwareApprovalController implements ApprovalController {
  constructor(private readonly options: ApprovalControllerOptions) {}

  checkRules(query: PermissionQuery): PermissionCheckResult {
    const ruleSet = this.options.getRuleSet?.();
    if (!ruleSet) return { decision: "ask" };
    return checkPermission(ruleSet, query);
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const ruleResult = this.checkRequestRules(req);

    if (ruleResult.decision === "deny") {
      return {
        action: "reject",
        feedback: `Blocked by deny rule: ${ruleResult.rule?.source ?? "<unknown>"}`,
      };
    }

    const mode = this.options.getMode();

    if (mode === "bypassPermissions") {
      return { action: "approve" };
    }

    if (mode === "default" && (req.type === "edit" || req.type === "write" || req.type === "patch")) {
      return { action: "approve" };
    }

    if (mode === "plan") {
      return {
        action: "reject",
        feedback:
          "Plan mode is active. Do not call destructive tools directly — propose your changes via exit_plan_mode and wait for user approval.",
      };
    }

    if (ruleResult.decision === "allow") {
      return { action: "approve" };
    }

    // Session-scoped allowlist: previously-approved bash prefixes skip the prompt.
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

  private requestToQuery(req: ApprovalRequest): PermissionQuery {
    switch (req.type) {
      case "bash":
        return { tool: "Bash", command: req.command };
      case "write":
        return { tool: "Write", path: req.path, cwd: this.options.cwd };
      case "edit":
        return { tool: "Edit", path: req.path, cwd: this.options.cwd };
      case "patch":
        return { tool: "Edit", path: req.path, cwd: this.options.cwd };
      case "lsp":
        return { tool: "Lsp", path: req.path, cwd: this.options.cwd };
    }
  }

  private checkRequestRules(req: ApprovalRequest): PermissionCheckResult {
    if (req.type !== "patch") return this.checkRules(this.requestToQuery(req));

    const perFile = req.files.map((file) => this.checkRules({
      tool: file.kind === "add" ? "Write" : "Edit",
      path: file.path,
      cwd: this.options.cwd,
    }));
    const denied = perFile.find((result) => result.decision === "deny");
    if (denied) return denied;
    if (perFile.length > 0 && perFile.every((result) => result.decision === "allow")) {
      return { decision: "allow", rule: perFile[0].rule };
    }
    return { decision: "ask" };
  }
}

import { checkPermission } from "../permissions/rule.js";
import type {
  PermissionCheckResult,
  PermissionQuery,
  PermissionRuleSet,
} from "../permissions/types.js";
import type { PermissionMode } from "../types.js";
import type { ExternalHookController } from "../hooks/controller.js";
import { truncateHookText } from "../hooks/index.js";
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
  /** External lifecycle hooks may observe or reject pending permission requests. */
  externalHooks?: ExternalHookController;
  sessionId?: string;
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
    const finalize = async (decision: ApprovalDecision): Promise<ApprovalDecision> => {
      await this.runPermissionResultHook(req, decision);
      return decision;
    };

    if (ruleResult.decision === "deny") {
      return finalize({
        action: "reject",
        feedback: `Blocked by deny rule: ${ruleResult.rule?.source ?? "<unknown>"}`,
      });
    }

    const mode = this.options.getMode();
    const hookDecision = await this.runPermissionRequestHook(req, mode, ruleResult.decision);
    if (hookDecision.action === "reject") {
      return finalize(hookDecision);
    }

    if (mode === "bypassPermissions") {
      return finalize({ action: "approve" });
    }

    if (mode === "default" && (req.type === "edit" || req.type === "write" || req.type === "patch")) {
      return finalize({ action: "approve" });
    }

    // Project profile trust is a user decision, not a destructive action:
    // spawn_agent is legal in plan mode, so the gate prompts there too.
    if (mode === "plan" && req.type !== "agent_profile") {
      return finalize({
        action: "reject",
        feedback:
          "Plan mode is active. Do not call destructive tools directly — propose your changes via exit_plan_mode and wait for user approval.",
      });
    }

    if (ruleResult.decision === "allow") {
      return finalize({ action: "approve" });
    }

    // Session-scoped allowlist: previously-approved bash prefixes skip the prompt.
    if (req.type === "bash" && this.options.bashAllowlist?.matches(req.command)) {
      return finalize({ action: "approve" });
    }

    const handler = this.options.handlerRef.current;
    if (!handler) {
      return finalize({
        action: "reject",
        feedback: "No interactive UI is available to approve this tool call.",
      });
    }

    return finalize(await handler(req));
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
      case "agent_profile":
        return { tool: "AgentProfile" };
      case "external_tool": {
        const command = externalCommand(req.rawInput);
        if (req.kind === "execute" && command !== undefined) {
          return { tool: "Bash", command };
        }
        const path = req.locations?.[0]?.path;
        if ((req.kind === "edit" || req.kind === "delete" || req.kind === "move") && path) {
          return { tool: "Edit", path, cwd: this.options.cwd };
        }
        return { tool: req.title.trim() || req.kind.trim() || "ExternalTool" };
      }
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

  private async runPermissionRequestHook(
    req: ApprovalRequest,
    mode: PermissionMode,
    ruleDecision: PermissionCheckResult["decision"],
  ): Promise<ApprovalDecision> {
    const hooks = this.options.externalHooks;
    if (!hooks) return { action: "approve" };
    try {
      const result = await hooks.runEvent({
        eventName: "PermissionRequest",
        cwd: this.options.cwd,
        sessionId: this.options.sessionId,
        agentRole: "driver",
        target: approvalTarget(req),
        payload: {
          request: summarizeApprovalRequest(req),
          mode,
          ruleDecision,
        },
        fullPayload: { permissionRequest: req },
      });
      if (result.decision === "deny") {
        return {
          action: "reject",
          feedback: result.reason ?? `Blocked by hook ${result.sourceHookId ?? "<unknown>"}.`,
        };
      }
    } catch {
      // Hook failures are handled by the hook controller policy and must not
      // crash approval handling.
    }
    return { action: "approve" };
  }

  private async runPermissionResultHook(
    req: ApprovalRequest,
    decision: ApprovalDecision,
  ): Promise<void> {
    const hooks = this.options.externalHooks;
    if (!hooks) return;
    try {
      await hooks.runEvent({
        eventName: "PermissionResult",
        cwd: this.options.cwd,
        sessionId: this.options.sessionId,
        agentRole: "driver",
        target: approvalTarget(req),
        payload: {
          request: summarizeApprovalRequest(req),
          decision: decision.action,
          feedback: decision.feedback ? truncateHookText(decision.feedback, 500) : undefined,
        },
        fullPayload: {
          permissionRequest: req,
          permissionDecision: decision,
        },
      });
    } catch {
      // Observe-only.
    }
  }
}

function approvalTarget(req: ApprovalRequest): string {
  switch (req.type) {
    case "bash":
      return "Bash";
    case "write":
      return "Write";
    case "edit":
    case "patch":
      return "Edit";
    case "lsp":
      return "Lsp";
    case "agent_profile":
      return "AgentProfile";
    case "external_tool":
      return req.title.trim() || req.kind.trim() || "ExternalTool";
  }
}

function summarizeApprovalRequest(req: ApprovalRequest): Record<string, unknown> {
  switch (req.type) {
    case "bash":
      return { type: req.type, commandPreview: truncateHookText(req.command, 500), cwd: req.cwd };
    case "write":
      return { type: req.type, path: req.path, fileExists: req.fileExists, contentLength: req.content.length };
    case "edit":
      return { type: req.type, path: req.path, fileExists: req.fileExists, diffLength: req.diff.length };
    case "patch":
      return { type: req.type, path: req.path, paths: req.paths, files: req.files, diffLength: req.diff.length };
    case "lsp":
      return { type: req.type, path: req.path, operation: req.operation };
    case "agent_profile":
      return { type: req.type, name: req.name, path: req.path, contentHash: req.contentHash };
    case "external_tool":
      return {
        type: req.type,
        toolCallId: req.toolCallId,
        title: req.title,
        kind: req.kind,
        locations: req.locations,
        rawInput: req.rawInput,
      };
  }
}

function externalCommand(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return undefined;
  const command = (rawInput as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

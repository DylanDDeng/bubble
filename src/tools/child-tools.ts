/**
 * Per-child tool factory for write_worktree subagents (design doc §8).
 *
 * Parent tools close over the parent cwd at creation, so a write child needs
 * fresh instances bound to its worktree — with their own FileStateTracker —
 * plus a worktree-scoped approval policy: file operations are runtime-checked
 * to stay under the worktree root (the tools' own workspace fence does this
 * structurally), bash auto-approves inside the worktree when the command
 * passes a deny-list of escaping operations, and everything else fails fast.
 */

import { isAbsolute, resolve, sep } from "node:path";
import type { ApprovalController, ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { PermissionCheckResult } from "../permissions/types.js";
import type { ToolRegistryEntry } from "../types.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { FileStateTracker } from "./file-state.js";

/** Operations a worktree child may never run, regardless of cwd. */
const WORKTREE_BASH_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b/, reason: "pushing from a subagent worktree is not allowed; the parent reviews and applies changes." },
  { pattern: /\bgit\s+remote\b/, reason: "remote configuration is not allowed inside a subagent worktree." },
  { pattern: /\bgit\s+worktree\b/, reason: "managing worktrees from inside a subagent worktree is not allowed." },
  { pattern: /\bsudo\b/, reason: "privileged commands are not allowed inside a subagent worktree." },
];

export function isPathInsideWorktree(worktreeRoot: string, candidate: string): boolean {
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(worktreeRoot, candidate);
  const root = resolve(worktreeRoot);
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * Approval policy for a worktree child: containment is enforced by code
 * (path checks, deny-list), never by prompt text. There is no interactive
 * fallback — anything outside the policy fails fast (design §11).
 */
export class WorktreeApprovalController implements ApprovalController {
  constructor(private readonly worktreeRoot: string) {}

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    switch (req.type) {
      case "bash": {
        for (const { pattern, reason } of WORKTREE_BASH_DENY_PATTERNS) {
          if (pattern.test(req.command)) {
            return { action: "reject", feedback: `Blocked by worktree policy: ${reason}` };
          }
        }
        if (!isPathInsideWorktree(this.worktreeRoot, req.cwd)) {
          return { action: "reject", feedback: "Blocked by worktree policy: commands must run inside the subagent worktree." };
        }
        // Absolute paths reaching outside the worktree are an escape attempt.
        const absolutePaths = req.command.match(/(?<=^|[\s"'=])\/[^\s"';|&]+/g) ?? [];
        for (const path of absolutePaths) {
          if (path.startsWith("/dev/") || path.startsWith("/tmp/") || path.startsWith("/usr/") || path.startsWith("/bin/") || path.startsWith("/opt/") || path.startsWith("/etc/")) continue;
          if (!isPathInsideWorktree(this.worktreeRoot, path)) {
            return {
              action: "reject",
              feedback: `Blocked by worktree policy: the command references a path outside the worktree (${path}).`,
            };
          }
        }
        return { action: "approve" };
      }
      case "edit":
      case "write":
        return isPathInsideWorktree(this.worktreeRoot, req.path)
          ? { action: "approve" }
          : { action: "reject", feedback: `Blocked by worktree policy: ${req.path} is outside the subagent worktree.` };
      case "patch":
        return req.paths.every((path) => isPathInsideWorktree(this.worktreeRoot, path))
          ? { action: "approve" }
          : { action: "reject", feedback: "Blocked by worktree policy: the patch touches paths outside the subagent worktree." };
      case "lsp":
        return { action: "approve" };
      case "agent_profile":
        return { action: "reject", feedback: "Subagents cannot approve agent profiles." };
      case "external_tool":
        return { action: "reject", feedback: "Subagents cannot approve external runtime tools." };
    }
  }

  checkRules(): PermissionCheckResult {
    return { decision: "ask" };
  }
}

const WORKTREE_TOOL_NAMES = new Set(["read", "glob", "grep", "edit", "write", "bash"]);

/**
 * Builds the write child's toolset bound to its worktree: fresh instances
 * with their own FileStateTracker and the worktree approval policy. A
 * profile's tools list can narrow the set but never widen it.
 */
/**
 * Isolates a readonly child's mutable tool state (design v2 §2): any tool that
 * exposes a cloneForChild hook (the standard `read`, which carries a
 * FileStateTracker) is rebuilt as a fresh per-child instance, so concurrent
 * members of a fan-out never share mutable tool state. Stateless tools
 * (glob/grep, web/memory/skill/todo) and custom/mock tools without the hook are
 * passed through unchanged. Write children get full isolation via
 * createWorktreeChildTools instead.
 */
export function isolateReadonlyChildFileTools(tools: ToolRegistryEntry[]): ToolRegistryEntry[] {
  return tools.map((tool) => (tool.cloneForChild ? tool.cloneForChild() : tool));
}

export function createWorktreeChildTools(worktreeCwd: string, include?: string[]): ToolRegistryEntry[] {
  const approval = new WorktreeApprovalController(worktreeCwd);
  const fileState = new FileStateTracker(worktreeCwd);
  const tools: ToolRegistryEntry[] = [
    createReadTool(worktreeCwd, approval, undefined, fileState),
    createGlobTool(worktreeCwd),
    createGrepTool(worktreeCwd),
    createEditTool(worktreeCwd, approval, undefined, fileState),
    createWriteTool(worktreeCwd, {}, approval, undefined, fileState),
    createBashTool(worktreeCwd, approval, fileState),
  ];
  if (!include || include.length === 0) return tools;
  const requested = new Set(include.filter((name) => WORKTREE_TOOL_NAMES.has(name)));
  return requested.size > 0 ? tools.filter((tool) => requested.has(tool.name)) : tools;
}

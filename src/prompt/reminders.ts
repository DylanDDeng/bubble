/**
 * System reminders - short, runtime-variable instructions injected into the
 * message stream as <system-reminder>-wrapped user messages with isMeta=true.
 *
 * Rationale: the static system prompt is stable and cacheable. Mode transitions
 * and other ephemeral state are signaled via reminders so we do not invalidate
 * the prompt cache every time something changes.
 */

import type { PermissionMode } from "../types.js";

export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

const PLAN_MODE_ENTER = `
Plan mode is now ACTIVE.

Rules while in plan mode:
- Only read-only tools are allowed (read, grep, web_search, web_fetch, skill, todo_write).
- Writes, edits, and shell commands WILL be rejected by the harness; do not try them.
- Investigate the codebase, then call exit_plan_mode with a concrete step-by-step plan.
- The user will approve, edit, or reject your plan. On approval the harness switches back to default mode and you may execute.
- On rejection, remain in plan mode and iterate.
`;

const ACCEPT_EDITS_ENTER = `
Permission mode is now: acceptEdits.

The user has granted blanket approval for file edits and writes in this session.
Bash commands still require explicit approval. Other tool safety rules are unchanged.
`;

const BYPASS_ENTER = `
Permission mode is now: bypassPermissions.

ALL tool calls auto-approve with no user confirmation. The user has explicitly opted into this.
Proceed with extra care — explain risky actions in the chat BEFORE performing them, and
prefer reversible operations when possible.
`;

const DONT_ASK_ENTER = `
Permission mode is now: dontAsk.

All tool calls auto-approve silently. Minimise narration; execute and report results tersely.
`;

const DEFAULT_ENTER = `
Permission mode is now: default. Each destructive tool call will be confirmed by the user.
`;

/** Picks the correct reminder text for a transition TO a given mode. */
export function reminderForMode(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return wrapInSystemReminder(PLAN_MODE_ENTER);
    case "acceptEdits":
      return wrapInSystemReminder(ACCEPT_EDITS_ENTER);
    case "bypassPermissions":
      return wrapInSystemReminder(BYPASS_ENTER);
    case "dontAsk":
      return wrapInSystemReminder(DONT_ASK_ENTER);
    case "default":
    default:
      return wrapInSystemReminder(DEFAULT_ENTER);
  }
}

// Backward-compat exports kept in case external code pinned the old names.
export const PLAN_MODE_ENTER_REMINDER = reminderForMode("plan");
export const PLAN_MODE_EXIT_REMINDER = reminderForMode("default");

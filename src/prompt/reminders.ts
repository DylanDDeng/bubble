/**
 * System reminders - short, runtime-variable instructions injected into the
 * message stream as <system-reminder>-wrapped user messages with isMeta=true.
 *
 * Rationale: the static system prompt is stable and cacheable. Mode transitions
 * and other ephemeral state are signaled via reminders so we do not invalidate
 * the prompt cache every time something changes.
 */

export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

export const PLAN_MODE_ENTER_REMINDER = wrapInSystemReminder(`
Plan mode is now ACTIVE.

Rules while in plan mode:
- Only read-only tools are allowed (read, grep, web_search, web_fetch, skill, todo_write).
- Writes, edits, and shell commands WILL be rejected by the harness; do not try them.
- Investigate the codebase, then call exit_plan_mode with a concrete step-by-step plan.
- The user will approve, edit, or reject your plan. On approval the harness switches back to default mode and you may execute.
- On rejection, remain in plan mode and iterate.
`);

export const PLAN_MODE_EXIT_REMINDER = wrapInSystemReminder(`
Plan mode has been exited. You may now use any available tool to execute the approved plan.
`);

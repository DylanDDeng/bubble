/**
 * System reminders - short, runtime-variable instructions injected into the
 * message stream as hidden meta messages.
 *
 * Rationale: the static system prompt is stable and cacheable. Mode transitions
 * and other ephemeral state are signaled via reminders so we do not invalidate
 * the prompt cache every time something changes.
 */

import type { PermissionMode } from "../types.js";

export function wrapInSystemReminder(content: string): string {
  return content.trim();
}

/**
 * Headlines of the mode reminders below. Identity is content-based because a
 * reminder is just text once it lands in the message stream; keeping the
 * headlines in one place stops the matcher from drifting when the bodies are
 * reworded.
 */
const MODE_REMINDER_HEADLINES = [
  "Plan mode is now ACTIVE",
  "Permission mode is now: bypassPermissions",
  "Permission mode is now: default Build mode",
];

export function isPermissionModeReminder(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return MODE_REMINDER_HEADLINES.some((headline) => content.includes(headline));
}

const PLAN_MODE_ENTER = `
Plan mode is now ACTIVE.

Rules while in plan mode:
- Only read-only tools are allowed, including read, glob, grep, web_search, web_fetch, spawn_agent, wait_agent, send_input, skill_search, skill, tool_search, question, and exit_plan_mode.
- Writes, edits, and shell commands WILL be rejected by the harness; do not try them.
- Do not edit files or claim implementation is complete while plan mode is active.
- Investigate the codebase, then use the question tool to clarify important ambiguities, tradeoffs, requirements, or preference choices that would materially change the plan.
- Call exit_plan_mode with a concrete step-by-step plan after the important questions are resolved.
- Do not use the question tool to ask whether the plan is approved; exit_plan_mode is the approval step.
- The user will approve, edit, or reject your plan. On approval the harness switches back to default mode and you may execute.
- On rejection, remain in plan mode and iterate.
`;

const BYPASS_ENTER = `
Permission mode is now: bypassPermissions.

This replaces every earlier mode reminder in this conversation. Plan mode is NOT active; exit_plan_mode does not exist in your tool list and must not be called or searched for.
ALL tool calls auto-approve with no user confirmation. The user has explicitly opted into this.
Proceed with extra care — explain risky actions in the chat BEFORE performing them, and
prefer reversible operations when possible.
Do not perform destructive operations, credential exposure, or unrelated reversions just because approvals are bypassed.
`;

const DEFAULT_ENTER = `
Permission mode is now: default Build mode.

This replaces every earlier mode reminder in this conversation. Plan mode is NOT active; exit_plan_mode does not exist in your tool list and must not be called or searched for.
File edits and writes auto-approve. Bash commands and other destructive tools still require explicit approval unless allowed by rules.
Execute the requested change end to end; do not stop at analysis unless blocked or the user explicitly asks for discussion only.
`;

/** Picks the correct reminder text for a transition TO a given mode. */
export function reminderForMode(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return wrapInSystemReminder(PLAN_MODE_ENTER);
    case "bypassPermissions":
      return wrapInSystemReminder(BYPASS_ENTER);
    case "default":
    default:
      return wrapInSystemReminder(DEFAULT_ENTER);
  }
}

export const PLAN_MODE_ENTER_REMINDER = reminderForMode("plan");
export const PLAN_MODE_EXIT_REMINDER = reminderForMode("default");

/**
 * Announce the set of deferred tools. Their schemas are not in the tool list
 * sent to the model — the model must call `tool_search` to load them before
 * they can be invoked.
 */
export function buildDeferredToolsReminder(names: string[]): string {
  if (names.length === 0) return wrapInSystemReminder("No deferred tools.");
  const lines = [
    "The following deferred tools are available via tool_search. Their schemas are NOT loaded — calling them directly will fail. Use tool_search with query \"select:<name>[,<name>...]\" to load tool schemas before calling them:",
    "",
    ...names,
  ];
  return wrapInSystemReminder(lines.join("\n"));
}

export function buildToolFreezeReminder(reason: string): string {
  return wrapInSystemReminder(`
CRITICAL - MAXIMUM STEPS REACHED

${reason}

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- statement that maximum steps for this agent have been reached
- summary of what has been accomplished so far
- list of any remaining tasks that were not completed
- recommendations for what should be done next

Respond with text ONLY.
`);
}

// Removed: buildVerificationReminder / buildVerificationFailureReminder.
// The verification reminder ladder pressured the model to run a "verification"
// after every file change. For models with hex-tokenization blind spots (e.g.
// DeepSeek v4-pro), this triggered death loops where the model wrote ad-hoc
// validation scripts that found the bug but could never fix it. CC trusts the
// model to decide when verification is meaningful; we follow that.

// Removed: buildFinalizeOpportunityReminder. Was paired with the verification
// nag ladder. Without the ladder, "you can finalize now" advice is redundant —
// the model finalises whenever its own judgement says the task is done.

/**
 * Modified-existing-tests disclosure (docs/harness-thinning.md): a fact from
 * git ground truth — bash writes and subagent worktree merges do not appear
 * in the model's own tool memory. Disclosure, not accusation: legitimate
 * test updates are normal engineering; the rule is that they must be
 * declared, never silent.
 */
export function buildModifiedTestsDisclosure(
  modifiedExistingTests: Array<{ path: string; deletedLines: number }>,
): string {
  const listed = modifiedExistingTests
    .slice(0, 8)
    .map((t) => `- ${t.path}${t.deletedLines > 0 ? ` (${t.deletedLines} line${t.deletedLines === 1 ? "" : "s"} removed)` : ""}`)
    .join("\n");
  return wrapInSystemReminder(`
Fact from git: this run modified pre-existing test files:
${listed}${modifiedExistingTests.length > 8 ? `\n- …and ${modifiedExistingTests.length - 8} more` : ""}

If a change you made caused an existing test to fail and you edited the test so the suite passes, restore the original behavior instead — weakening a test to make it pass is never acceptable. If the test changes are intentional (the request requires new expected behavior, or the test itself was wrong), keep them and state each modified test and the reason in your final summary. Then finish normally.
`);
}

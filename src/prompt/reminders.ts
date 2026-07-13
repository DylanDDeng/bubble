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

export function isPermissionModeReminder(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return content.includes("Plan mode is now ACTIVE")
    || content.includes("Permission mode is now: bypassPermissions")
    || content.includes("Permission mode is now: default Build mode");
}

const PLAN_MODE_ENTER = `
Plan mode is now ACTIVE.

Rules while in plan mode:
- Only read-only tools are allowed, including read, glob, grep, web_search, web_fetch, spawn_agent, wait_agent, send_input, skill_search, skill, todo_write, tool_search, question, and exit_plan_mode.
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

ALL tool calls auto-approve with no user confirmation. The user has explicitly opted into this.
Proceed with extra care — explain risky actions in the chat BEFORE performing them, and
prefer reversible operations when possible.
Do not perform destructive operations, credential exposure, or unrelated reversions just because approvals are bypassed.
`;

const DEFAULT_ENTER = `
Permission mode is now: default Build mode.

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

export function buildInvestigationReminder(): string {
  return wrapInSystemReminder(`
Security/configuration investigation workflow is active.

For this task, gather evidence in this order:
- locate config load paths
- locate environment variable reads
- locate persistent storage paths
- check whether sensitive values are masked or redacted
- check whether values can reach logs, client bundles, or user-visible surfaces

Stop once these categories are covered. Do not keep repeating near-identical searches when they are not producing new evidence.
`);
}

export function buildLoopWarningReminder(reason: string): string {
  return wrapInSystemReminder(`
Further broad exploration is low value unless there is a concrete remaining evidence gap.

${reason}

Do not repeat near-identical reads or searches unless the path or hypothesis is materially different.
If current evidence is sufficient, answer with the findings.
`);
}

export function buildSearchFreezeReminder(reason: string): string {
  return wrapInSystemReminder(`
Search tools are now constrained for this task.

Reason: ${reason}

Do not continue blind keyword searching. Use the evidence already gathered to reason about the answer.
You may still read specific files if you already know where the relevant configuration or persistence logic lives.
`);
}

export function buildExplorationFreezeReminder(reason: string): string {
  return wrapInSystemReminder(`
Implementation phase has advanced from exploration to modification.

Reason: ${reason}

You have enough context to act. Do not continue reading, searching, or delegating exploration.
Choose one of:
1. Use edit/write to make the requested change.
2. If no safe change can be made from the gathered context, explain the concrete blocker.
3. If files were already changed, run the narrowest meaningful verification or finish with the result.
`);
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

export function buildWorkflowPhaseReminder(input: {
  phase: "investigate" | "correlate" | "conclude";
  covered: string[];
  pending: string[];
}): string {
  const phaseInstructions: Record<typeof input.phase, string> = {
    investigate: "Collect direct evidence. Prefer targeted reads and structured searches over blind keyword churn.",
    correlate: "Stop broad searching. Correlate the evidence you already have and fill only the most specific remaining gaps.",
    conclude: "You have enough evidence to answer. Do not continue exploring unless you discover a concrete contradiction in the current evidence.",
  };

  const covered = input.covered.length > 0 ? input.covered.map((item) => `- ${item}`).join("\n") : "- none yet";
  const pending = input.pending.length > 0 ? input.pending.map((item) => `- ${item}`).join("\n") : "- none";

  return wrapInSystemReminder(`
Workflow phase: ${input.phase}

${phaseInstructions[input.phase]}

Covered evidence:
${covered}

Remaining evidence to check:
${pending}
`);
}


// Removed: buildVerificationReminder / buildVerificationFailureReminder.
// The verification reminder ladder pressured the model to run a "verification"
// after every file change. For models with hex-tokenization blind spots (e.g.
// DeepSeek v4-pro), this triggered death loops where the model wrote ad-hoc
// validation scripts that found the bug but could never fix it. CC trusts the
// model to decide when verification is meaningful; we follow that.

/**
 * Fired when a file mutation failure suggests the model may be relying on stale
 * local memory instead of the current file bytes. Models — especially
 * thinking-heavy ones — can otherwise spiral on `No changes made: identical
 * content` or `oldText not found` because their internal reasoning convinces
 * them they are typing the change correctly.
 */
export function buildEditRetryEscalationReminder(reason: string): string {
  return wrapInSystemReminder(`
A file mutation just failed in a way that usually means your local view of the file is stale or the edit anchor is wrong.

${reason}

Stop retrying from memory. Pick one of:
- Re-read the target file and compare the actual bytes to your intended oldText / newText. Trailing whitespace, unicode lookalikes, or off-by-one boundaries are common causes.
- If you intended to add a single character (e.g. fixing a 5-digit hex color to 6 digits), confirm that your newText string actually contains the added character before sending again.
- Use the write tool with the full new content instead of edit — useful when the change spans many lines or the diff anchor is ambiguous.
- If you cannot determine the cause, ask the user for clarification.
`);
}

/**
 * Fired the FIRST time the model re-reads a file it already read in this turn.
 * Soft — does not freeze the tool. The model may still re-read when context was
 * pruned, the requested range changed, or a later mutation needs verification.
 */
export function buildRedundantReadReminder(path: string): string {
  return wrapInSystemReminder(`
You already read ${path} earlier in this turn. If that content is still available and nothing changed, rely on it rather than re-reading.
It is okay to re-read when you need to recover pruned context, inspect a different range, or verify a later edit/write/bash change.
`);
}

/**
 * Injected once at task start when the user's input looks like a small,
 * focused task (e.g. "write an HTML page about X"). Counterweight to the
 * default protocol which biases toward thorough exploration.
 */
export function buildSmallTaskHint(): string {
  return wrapInSystemReminder(`
This appears to be a small, focused task (short request, single deliverable, no integration ambiguity).

Prefer direct execution over exploration:
- If the target file path is given or obvious, use write/edit directly.
- Do not glob, read, or grep adjacent files unless the request explicitly references them.
- Do not pre-plan with todo_write for tasks that can be done in one or two tool calls.
- Skip the "investigate the codebase" step that applies to larger changes.
`);
}

// Removed: buildFinalizeOpportunityReminder. Was paired with the verification
// nag ladder. Without the ladder, "you can finalize now" advice is redundant —
// the model finalises whenever its own judgement says the task is done.

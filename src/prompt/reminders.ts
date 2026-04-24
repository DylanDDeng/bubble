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
- Only read-only tools are allowed (read, grep, web_search, web_fetch, task, skill, todo_write).
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
Search loop warning.

${reason}

Do not repeat near-identical grep/bash searches unless you are changing the path or testing a genuinely new hypothesis.
If current evidence is sufficient, summarize your findings now.
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

export function buildTaskSummaryReminder(): string {
  return wrapInSystemReminder(`
Summarize the task tool output above and continue with your task.

Treat the task output as a bounded subtask result:
- extract the findings that matter
- integrate them into your main reasoning
- do not re-run the same exploratory search unless the subtask uncovered a concrete contradiction
`);
}

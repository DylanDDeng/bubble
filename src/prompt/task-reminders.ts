import type { TaskType } from "../agent/task-classifier.js";
import { wrapInSystemReminder } from "./reminders.js";

export interface TaskReminderOptions {
  /** Whether this agent has the delegation tools (parent agents only). */
  canDelegate?: boolean;
}

/**
 * Delegation nudge for exploration-shaped tasks: injected at the decision
 * point (start of turn), where it carries far more weight for weakly
 * delegating models than the session-start system prompt. Task-type gating
 * keeps it away from ordinary implementation/debugging turns, so it cannot
 * amplify over-delegation.
 */
const DELEGATION_NUDGE =
  "- If answering needs scanning many files and only the conclusion matters, delegate to a background subagent (spawn_agent); when it is the same read-only question over several independent items, fan out with agent_team.";

export function reminderForTaskType(taskType: TaskType, options: TaskReminderOptions = {}): string | undefined {
  switch (taskType) {
    case "debugging":
      return wrapInSystemReminder(`
Debugging workflow:
- Reproduce or identify the failing boundary before editing.
- Trace input, transformation, and output paths.
- Prefer fixing the mechanism over raising thresholds or adding superficial fallbacks.
- Verify the specific failure path after the change.
`);
    case "implementation":
      return wrapInSystemReminder(`
Implementation workflow:
- Do not stop at a proposal when the user asked for a change.
- Inspect the relevant files first, then make the smallest coherent edit.
- Keep unrelated files and behavior out of scope.
- Run a narrow verification command or explain why it cannot be run.
`);
    case "code_review":
      return wrapInSystemReminder(`
Code review workflow:
- Lead with concrete findings, ordered by severity.
- Reference file paths and line numbers when possible.
- Prioritize bugs, regressions, missing tests, security, and user-visible risk.
- Keep summaries secondary to findings.
`);
    case "code_explanation":
      return wrapInSystemReminder(`
Code explanation workflow:
- Answer the direct question first.
- Ground claims in concrete files, functions, and call paths.
- Distinguish current source evidence from inference.
- Avoid proposing changes unless the user asks for them.
`);
    case "repo_orientation":
      return wrapInSystemReminder(`
Repository orientation workflow:
- Start with the repo purpose and main execution paths.
- Inspect README/package metadata plus core runtime files before summarizing.
- Keep the first pass read-only unless the user asks for changes or runtime verification.
${options.canDelegate ? `${DELEGATION_NUDGE}\n` : ""}`);
    case "product_discussion":
      return wrapInSystemReminder(`
Product discussion workflow:
- Clarify the product goal, user workflow, and tradeoffs before suggesting implementation.
- Give direct product judgment when the user asks for direction.
- Avoid drifting into code changes unless the user explicitly asks to execute.
`);
    case "security_investigation":
    case "code_search":
    case "general":
    default:
      return undefined;
  }
}

/**
 * Pure decision logic for the goal auto-continuation loop.
 *
 * Kept out of the TUI so the stop conditions can be unit-tested directly. The
 * TUI calls shouldContinueGoal() after each goal turn finishes and either fires
 * another turn or stops with the returned reason.
 *
 * The agent decides when the work is done — there is intentionally NO turn-count
 * cap (unlike a fixed iteration limit). The loop only stops when:
 *   - the model marks the goal complete/blocked (via update_goal),
 *   - the user pauses/clears it,
 *   - the run is interrupted or the provider errors (out of quota, network, …),
 *   - or a user-set token budget is exhausted.
 * Otherwise it keeps going.
 */

import type { GoalState } from "./store.js";

export type GoalStopReason =
  | "complete"
  | "blocked"
  | "paused"
  | "budget"
  | "error"
  | "cancelled"
  | "user_input"
  | "no_goal";

export interface ContinueDecisionInput {
  goal: GoalState | null;
  /** The last run was interrupted/cancelled by the user. */
  cancelled?: boolean;
  /** The last run failed with a provider/run error (quota, network, API). */
  errored?: boolean;
  /** Number of user inputs queued to run next (a real message preempts the goal). */
  queuedInputs?: number;
}

export interface ContinueDecision {
  continue: boolean;
  reason?: GoalStopReason;
}

export function shouldContinueGoal(input: ContinueDecisionInput): ContinueDecision {
  const { goal } = input;
  if (!goal) return { continue: false, reason: "no_goal" };
  if (input.errored) return { continue: false, reason: "error" };
  if (input.cancelled) return { continue: false, reason: "cancelled" };
  if ((input.queuedInputs ?? 0) > 0) return { continue: false, reason: "user_input" };

  switch (goal.status) {
    case "complete":
      return { continue: false, reason: "complete" };
    case "blocked":
      return { continue: false, reason: "blocked" };
    case "paused":
      return { continue: false, reason: "paused" };
    case "budget_limited":
      return { continue: false, reason: "budget" };
    case "active":
      break;
  }

  // Only an explicit, user-set token budget bounds the loop; with no budget it
  // runs until the model finishes, the user stops it, or the provider errors.
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return { continue: false, reason: "budget" };
  }

  return { continue: true };
}

/** Human-readable one-liner explaining why auto-continuation stopped. */
export function stopReasonNotice(reason: GoalStopReason | undefined): string {
  switch (reason) {
    case "complete":
      return "Goal complete.";
    case "blocked":
      return "Goal marked blocked — /goal resume to retry.";
    case "paused":
      return "Goal paused — /goal resume to continue.";
    case "budget":
      return "Goal hit its token budget — /goal resume to continue.";
    case "error":
      return "Goal paused — the provider errored. Fix it, then /goal resume.";
    case "cancelled":
      return "Goal paused (interrupted) — /goal resume to continue.";
    case "user_input":
      return "Goal paused for your input — it resumes after this turn.";
    default:
      return "";
  }
}

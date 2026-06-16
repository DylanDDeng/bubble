/**
 * Pure decision logic for the goal auto-continuation loop.
 *
 * Kept out of the TUI so the stop conditions can be unit-tested directly. The
 * TUI calls shouldContinueGoal() after each goal turn finishes and either fires
 * another turn or stops with the returned reason.
 */

import type { GoalState } from "./store.js";

/** Safety cap on consecutive automatic continuations before the loop pauses. */
export const GOAL_MAX_AUTO_TURNS = 40;

export type GoalStopReason =
  | "complete"
  | "blocked"
  | "paused"
  | "budget"
  | "cap"
  | "cancelled"
  | "user_input"
  | "no_goal";

export interface ContinueDecisionInput {
  goal: GoalState | null;
  /** The last run was interrupted/cancelled by the user. */
  cancelled?: boolean;
  /** Number of user inputs queued to run next (a real message preempts the goal). */
  queuedInputs?: number;
  /** Consecutive automatic continuations already taken this streak. */
  autoTurns?: number;
  cap?: number;
}

export interface ContinueDecision {
  continue: boolean;
  reason?: GoalStopReason;
}

export function shouldContinueGoal(input: ContinueDecisionInput): ContinueDecision {
  const { goal } = input;
  if (!goal) return { continue: false, reason: "no_goal" };
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

  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return { continue: false, reason: "budget" };
  }

  const cap = input.cap ?? GOAL_MAX_AUTO_TURNS;
  if ((input.autoTurns ?? 0) >= cap) return { continue: false, reason: "cap" };

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
    case "cap":
      return "Goal reached the auto-continuation limit — /goal resume to continue.";
    case "cancelled":
      return "Goal paused (interrupted) — /goal resume to continue.";
    case "user_input":
      return "Goal paused for your input — it resumes after this turn.";
    default:
      return "";
  }
}

/**
 * Display helpers for the goal feature — shared by the goal tools (model-facing
 * summary), the `/goal` summary command, and the TUI status-line indicator.
 */

import type { GoalState, GoalStatus } from "./store.js";

export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "budget_limited":
      return "budget limited";
    case "complete":
      return "complete";
  }
}

/** Compact token count: 950, 1.2K, 63.9K, 1.5M. */
export function formatTokensCompact(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${trimZero(n / 1_000)}K`;
  return `${trimZero(n / 1_000_000)}M`;
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function tokensPart(goal: GoalState): string | undefined {
  if (goal.tokenBudget !== undefined) {
    return `${formatTokensCompact(goal.tokensUsed)}/${formatTokensCompact(goal.tokenBudget)} tok`;
  }
  if (goal.tokensUsed > 0) return `${formatTokensCompact(goal.tokensUsed)} tok`;
  return undefined;
}

/** Full multi-detail summary, e.g. for the model's get_goal result. */
export function goalSummaryText(goal: GoalState): string {
  const parts = [
    `Objective: ${goal.objective}`,
    `Status: ${goalStatusLabel(goal.status)}.`,
    `Turns: ${goal.turnsSpent}.`,
  ];
  const tokens = tokensPart(goal);
  if (tokens) parts.push(`Tokens: ${tokens}.`);
  if (goal.tokenBudget !== undefined) {
    const remaining = Math.max(0, goal.tokenBudget - goal.tokensUsed);
    parts.push(`Remaining budget: ${formatTokensCompact(remaining)} tok.`);
  }
  return parts.join(" ");
}

/** Compact single-line indicator for the status line / sidebar. */
export function goalIndicatorLine(goal: GoalState, maxObjective = 48): string {
  const segments = [`goal: ${goalStatusLabel(goal.status)}`, `${goal.turnsSpent} turns`];
  const tokens = tokensPart(goal);
  if (tokens) segments.push(tokens);
  const objective = truncateObjective(goal.objective, maxObjective);
  return `${segments.join(" · ")} — ${objective}`;
}

function truncateObjective(objective: string, max: number): string {
  const single = objective.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(0, max - 1))}…`;
}

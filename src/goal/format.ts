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
  const untracked = goal.untrackedTokenTurns ?? 0;
  if (untracked > 0) {
    const turns = `${untracked} ${untracked === 1 ? "turn" : "turns"}`;
    if (goal.tokensUsed > 0) {
      const budget = goal.tokenBudget !== undefined
        ? `/${formatTokensCompact(goal.tokenBudget)}`
        : "";
      return `${formatTokensCompact(goal.tokensUsed)}${budget} tok tracked; usage unavailable for ${turns}`;
    }
    if (goal.tokenBudget !== undefined) {
      return `usage unavailable for ${turns}; budget ${formatTokensCompact(goal.tokenBudget)} tok`;
    }
    return `usage unavailable for ${turns}`;
  }
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

/**
 * Terminal notice shown when a goal finishes, with the accurate final token
 * spend. Call only after the finishing run's tokens have been accounted (the
 * update_goal tool can't report this — see goal/tools.ts).
 */
export function goalCompleteNotice(goal: GoalState): string {
  const tokens = completionTokenUsagePhrase(goal);
  const turns = `${goal.turnsSpent} ${goal.turnsSpent === 1 ? "turn" : "turns"}`;
  return `Goal complete — ${tokens} over ${turns}.`;
}

function completionTokenUsagePhrase(goal: GoalState): string {
  const untracked = goal.untrackedTokenTurns ?? 0;
  if (untracked > 0) {
    if (goal.tokensUsed > 0) {
      const budget = goal.tokenBudget !== undefined
        ? `/${formatTokensCompact(goal.tokenBudget)}`
        : "";
      return `${formatTokensCompact(goal.tokensUsed)}${budget} tok used, plus unavailable usage`;
    }
    if (goal.tokenBudget !== undefined) {
      return `token usage unavailable (budget ${formatTokensCompact(goal.tokenBudget)} tok)`;
    }
    return "token usage unavailable";
  }
  return goal.tokenBudget !== undefined
    ? `${formatTokensCompact(goal.tokensUsed)}/${formatTokensCompact(goal.tokenBudget)} tok used`
    : `${formatTokensCompact(goal.tokensUsed)} tok used`;
}

/** Compact single-line indicator for status surfaces. */
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

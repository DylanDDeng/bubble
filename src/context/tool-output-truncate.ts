// Tool-output truncation honoring the model's server-declared limit.
//
// Codex backend's /models endpoint reports per-model `truncation_policy.limit`
// (e.g. 10000 tokens for gpt-5.5). The expectation is that the CLIENT truncates
// each tool result to that budget before adding it to history; sending raw
// 50-100k tool dumps will blow through the input window after a handful of
// calls. Codex CLI does this via TruncationPolicy::Tokens; mirror it here.
//
// Strategy: middle-truncate (preserve head + tail with an explicit marker in
// between). Heads usually carry structure/headers; tails often carry totals,
// errors, or conclusions — losing either is worse than losing the middle.

import { getToolOutputTokenLimit } from "../model-catalog.js";
import { estimateTextTokens } from "./budget.js";

export interface ToolTruncationResult {
  content: string;
  truncated: boolean;
  originalTokens: number;
  finalTokens: number;
  limit: number | undefined;
}

export function truncateToolOutputForModel(
  content: string,
  providerId: string,
  modelId: string,
): ToolTruncationResult {
  const limit = getToolOutputTokenLimit(providerId, modelId);
  const originalTokens = estimateTextTokens(content, providerId);

  if (!limit || originalTokens <= limit) {
    return { content, truncated: false, originalTokens, finalTokens: originalTokens, limit };
  }

  const truncated = middleTruncateToTokenBudget(content, limit, providerId);
  const finalTokens = estimateTextTokens(truncated, providerId);
  return { content: truncated, truncated: true, originalTokens, finalTokens, limit };
}

function middleTruncateToTokenBudget(content: string, tokenBudget: number, providerId: string): string {
  // Convert token budget to a char budget via the estimator's effective ratio.
  // The estimator may under/overcount, so we iterate one round if needed.
  const tokensAll = estimateTextTokens(content, providerId);
  if (tokensAll <= tokenBudget) return content;

  const charsPerToken = content.length / Math.max(1, tokensAll);
  let charBudget = Math.floor(tokenBudget * charsPerToken);
  const marker = (dropped: number) =>
    `\n\n[... middle ${formatChars(dropped)} truncated by model policy (${tokenBudget}-token cap) ...]\n\n`;

  // Reserve some room for the marker itself.
  const reserveForMarker = 200;
  charBudget = Math.max(200, charBudget - reserveForMarker);

  const half = Math.floor(charBudget / 2);
  const head = content.slice(0, half);
  const tail = content.slice(content.length - (charBudget - half));
  const droppedChars = content.length - head.length - tail.length;
  let truncated = `${head}${marker(droppedChars)}${tail}`;

  // Tighten if our estimate of charsPerToken undercounts and we're still over.
  let safety = 3;
  while (estimateTextTokens(truncated, providerId) > tokenBudget && safety-- > 0) {
    const newHalf = Math.floor(head.length * 0.8);
    const newTailLen = Math.floor(tail.length * 0.8);
    const newHead = content.slice(0, newHalf);
    const newTail = content.slice(content.length - newTailLen);
    const newDropped = content.length - newHead.length - newTail.length;
    truncated = `${newHead}${marker(newDropped)}${newTail}`;
  }

  return truncated;
}

function formatChars(count: number): string {
  if (count < 1000) return `${count} chars`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K chars`;
  return `${(count / 1_000_000).toFixed(2)}M chars`;
}

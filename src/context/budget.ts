import { getModelContextWindow } from "../model-catalog.js";
import type { Message } from "../types.js";

export const OUTPUT_RESERVE_TOKENS = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const PRUNE_BUFFER_TOKENS = 50_000;
export const MIN_WINDOW_FOR_RESERVE = 40_000;

export interface ContextBudget {
  estimatedTokens: number;
  contextWindow?: number;
  percent?: number;
  shouldPrune: boolean;
  shouldCompact: boolean;
}

export interface ContextBudgetOptions {
  /** Authoritative input-token count from the most recent response usage. */
  usageAnchorTokens?: number;
  /** Messages appended after the anchor (their tokens are estimated and added). */
  tailMessages?: Message[];
}

export function estimateMessageTokens(message: Message): number {
  switch (message.role) {
    case "system":
    case "tool":
      return estimateTextTokens(message.content);
    case "assistant":
      return estimateTextTokens(message.content)
        + estimateTextTokens(message.reasoning ?? "")
        + (message.toolCalls?.reduce((sum, toolCall) => sum + estimateTextTokens(toolCall.arguments) + 12, 0) ?? 0)
        + 8;
    case "user":
      if (typeof message.content === "string") {
        return estimateTextTokens(message.content) + 8;
      }
      return message.content.reduce((sum, part) => {
        if (part.type === "text") {
          return sum + estimateTextTokens(part.text);
        }
        return sum + 256;
      }, 8);
  }
}

export function estimateContextTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function getContextBudget(
  providerId: string,
  modelId: string,
  messages: Message[],
  options: ContextBudgetOptions = {},
): ContextBudget {
  const estimatedTokens = computeEstimatedTokens(messages, options);
  const contextWindow = getModelContextWindow(providerId, modelId);
  const percent = contextWindow ? Math.min(100, (estimatedTokens / contextWindow) * 100) : undefined;

  return {
    estimatedTokens,
    contextWindow,
    percent,
    shouldPrune: shouldTriggerPrune(estimatedTokens, contextWindow),
    shouldCompact: shouldTriggerCompact(estimatedTokens, contextWindow),
  };
}

function computeEstimatedTokens(messages: Message[], options: ContextBudgetOptions): number {
  if (options.usageAnchorTokens !== undefined && options.tailMessages) {
    return options.usageAnchorTokens + estimateContextTokens(options.tailMessages);
  }
  return estimateContextTokens(messages);
}

function shouldTriggerPrune(estimatedTokens: number, contextWindow?: number): boolean {
  if (!contextWindow) {
    return estimatedTokens >= 16_000;
  }
  const threshold = contextWindow >= MIN_WINDOW_FOR_RESERVE
    ? contextWindow - OUTPUT_RESERVE_TOKENS - PRUNE_BUFFER_TOKENS
    : contextWindow * 0.55;
  return estimatedTokens >= threshold;
}

function shouldTriggerCompact(estimatedTokens: number, contextWindow?: number): boolean {
  if (!contextWindow) {
    return estimatedTokens >= 32_000;
  }
  const threshold = contextWindow >= MIN_WINDOW_FOR_RESERVE
    ? contextWindow - OUTPUT_RESERVE_TOKENS - AUTOCOMPACT_BUFFER_TOKENS
    : contextWindow * 0.75;
  return estimatedTokens >= threshold;
}

function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

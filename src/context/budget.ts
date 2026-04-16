import { getModelContextWindow } from "../model-catalog.js";
import type { Message } from "../types.js";

export interface ContextBudget {
  estimatedTokens: number;
  contextWindow?: number;
  percent?: number;
  shouldPrune: boolean;
  shouldCompact: boolean;
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
): ContextBudget {
  const estimatedTokens = estimateContextTokens(messages);
  const contextWindow = getModelContextWindow(providerId, modelId);
  const percent = contextWindow ? Math.min(100, (estimatedTokens / contextWindow) * 100) : undefined;

  return {
    estimatedTokens,
    contextWindow,
    percent,
    shouldPrune: percent !== undefined ? percent >= 55 : estimatedTokens >= 16000,
    shouldCompact: percent !== undefined ? percent >= 80 : estimatedTokens >= 32000,
  };
}

function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

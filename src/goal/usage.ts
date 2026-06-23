import type { TokenUsage } from "../types.js";

export function tokenUsageTotal(usage: TokenUsage): number {
  return usage.totalTokens ?? ((usage.promptTokens || 0) + (usage.completionTokens || 0));
}

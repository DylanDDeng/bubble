import type { TokenUsage } from "./types.js";

export interface ModelPricing {
  providerId: string;
  modelId: string;
  currency: "USD";
  inputCacheHitPerMillion: number;
  inputCacheMissPerMillion: number;
  outputPerMillion: number;
  effectiveUntil?: string;
  original?: {
    inputCacheHitPerMillion: number;
    inputCacheMissPerMillion: number;
    outputPerMillion: number;
  };
}

export interface UsageCost {
  currency: "USD";
  cost: number;
  estimated: boolean;
}

export const MODEL_PRICING: ModelPricing[] = [
  {
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    currency: "USD",
    inputCacheHitPerMillion: 0.028,
    inputCacheMissPerMillion: 0.14,
    outputPerMillion: 0.28,
  },
  {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    currency: "USD",
    inputCacheHitPerMillion: 0.03625,
    inputCacheMissPerMillion: 0.435,
    outputPerMillion: 0.87,
    effectiveUntil: "2026-05-05T15:59:00Z",
    original: {
      inputCacheHitPerMillion: 0.145,
      inputCacheMissPerMillion: 1.74,
      outputPerMillion: 3.48,
    },
  },
];

export function getModelPricing(providerId: string, modelId: string): ModelPricing | undefined {
  return MODEL_PRICING.find((item) => item.providerId === providerId && item.modelId === modelId);
}

export function calculateUsageCost(providerId: string, modelId: string, usage: TokenUsage): UsageCost | undefined {
  const pricing = getModelPricing(providerId, modelId);
  if (!pricing) return undefined;

  const hasCacheBreakdown =
    typeof usage.promptCacheHitTokens === "number"
    || typeof usage.promptCacheMissTokens === "number";
  const hit = usage.promptCacheHitTokens ?? 0;
  const miss = hasCacheBreakdown
    ? usage.promptCacheMissTokens ?? Math.max(0, usage.promptTokens - hit)
    : usage.promptTokens;
  const cost =
    (hit / 1_000_000) * pricing.inputCacheHitPerMillion
    + (miss / 1_000_000) * pricing.inputCacheMissPerMillion
    + (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;

  return {
    currency: pricing.currency,
    cost,
    estimated: !hasCacheBreakdown,
  };
}

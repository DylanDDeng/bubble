import { describe, expect, it } from "vitest";
import { calculateUsageCost, getModelPricing } from "../model-pricing.js";

describe("model pricing", () => {
  it("contains current DeepSeek v4 pricing", () => {
    expect(getModelPricing("deepseek", "deepseek-v4-flash")).toMatchObject({
      inputCacheHitPerMillion: 0.028,
      inputCacheMissPerMillion: 0.14,
      outputPerMillion: 0.28,
    });
    expect(getModelPricing("deepseek", "deepseek-v4-pro")).toMatchObject({
      inputCacheHitPerMillion: 0.03625,
      inputCacheMissPerMillion: 0.435,
      outputPerMillion: 0.87,
      effectiveUntil: "2026-05-05T15:59:00Z",
    });
  });

  it("calculates DeepSeek cache-aware cost", () => {
    const result = calculateUsageCost("deepseek", "deepseek-v4-pro", {
      promptTokens: 1_000_000,
      promptCacheHitTokens: 250_000,
      promptCacheMissTokens: 750_000,
      completionTokens: 500_000,
    });

    expect(result).toEqual({
      currency: "USD",
      cost: 0.25 * 0.03625 + 0.75 * 0.435 + 0.5 * 0.87,
      estimated: false,
    });
  });

  it("treats prompt tokens as cache misses when cache breakdown is absent", () => {
    const result = calculateUsageCost("deepseek", "deepseek-v4-flash", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(result?.currency).toBe("USD");
    expect(result?.estimated).toBe(true);
    expect(result?.cost).toBeCloseTo(0.42);
  });
});

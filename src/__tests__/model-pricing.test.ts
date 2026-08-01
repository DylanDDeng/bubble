import { describe, expect, it } from "vitest";
import { calculateUsageCost, getModelPricing } from "../model-pricing.js";

describe("model pricing", () => {
  it("contains Claude Fable 5 USD pricing", () => {
    // Anthropic bills a cache read at 0.1x base input and a 5-minute cache write
    // at 1.25x. The hit rate here used to be pinned at the full 10/M base price,
    // which overstated every cached Fable run tenfold.
    expect(getModelPricing("anthropic", "claude-fable-5")).toMatchObject({
      currency: "USD",
      inputCacheHitPerMillion: 1,
      inputCacheMissPerMillion: 10,
      inputCacheWritePerMillion: 12.5,
      outputPerMillion: 50,
    });
  });

  it("contains Claude Opus 4.8 pricing, which was missing entirely", () => {
    // Without an entry, calculateUsageCost returned undefined and Opus runs
    // displayed as unpriced — a $100+ benchmark run showed no cost at all.
    expect(getModelPricing("anthropic", "claude-opus-4-8")).toMatchObject({
      currency: "USD",
      inputCacheHitPerMillion: 0.5,
      inputCacheMissPerMillion: 5,
      inputCacheWritePerMillion: 6.25,
      outputPerMillion: 25,
    });
  });

  it("contains current DeepSeek v4 pricing", () => {
    // Cache-hit rates were pinned at 10x the official price (0.028/0.03625 vs
    // 0.0028/0.003625 on api-docs.deepseek.com), overstating cached-input cost.
    expect(getModelPricing("deepseek", "deepseek-v4-flash")).toMatchObject({
      inputCacheHitPerMillion: 0.0028,
      inputCacheMissPerMillion: 0.14,
      outputPerMillion: 0.28,
    });
    // The 2026-05-05 "promotional" rate became the standard price, so the
    // effectiveUntil/original promo fields are gone.
    expect(getModelPricing("deepseek", "deepseek-v4-pro")).toMatchObject({
      inputCacheHitPerMillion: 0.003625,
      inputCacheMissPerMillion: 0.435,
      outputPerMillion: 0.87,
    });
    expect(getModelPricing("deepseek", "deepseek-v4-pro")?.effectiveUntil).toBeUndefined();
  });

  it("contains StepFun step-3.7-flash CNY pricing", () => {
    expect(getModelPricing("stepfun", "step-3.7-flash")).toMatchObject({
      currency: "CNY",
      inputCacheHitPerMillion: 0.27,
      inputCacheMissPerMillion: 1.35,
      outputPerMillion: 8.1,
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
      cost: 0.25 * 0.003625 + 0.75 * 0.435 + 0.5 * 0.87,
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

  it("calculates StepFun cache-aware CNY cost", () => {
    const result = calculateUsageCost("stepfun", "step-3.7-flash", {
      promptTokens: 1_000_000,
      promptCacheHitTokens: 250_000,
      promptCacheMissTokens: 750_000,
      completionTokens: 500_000,
    });

    expect(result).toEqual({
      currency: "CNY",
      cost: 0.25 * 0.27 + 0.75 * 1.35 + 0.5 * 8.1,
      estimated: false,
    });
  });
  it("prices Anthropic cache writes at the write rate, not the miss rate", () => {
    // promptCacheMissTokens already CONTAINS cacheCreationTokens, so a naive
    // "+ creation * writeRate" on top of the untouched miss term would bill the
    // written tokens at miss + write (2.25x base) instead of 1.25x.
    const result = calculateUsageCost("anthropic", "claude-opus-4-8", {
      promptTokens: 1_000_000,
      promptCacheHitTokens: 700_000,
      promptCacheMissTokens: 300_000,
      cacheCreationTokens: 250_000,
      completionTokens: 100_000,
    });

    expect(result).toEqual({
      currency: "USD",
      // 0.7M read @0.5 + 0.25M write @6.25 + 0.05M uncached @5 + 0.1M out @25
      cost: 0.7 * 0.5 + 0.25 * 6.25 + 0.05 * 5 + 0.1 * 25,
      estimated: false,
    });
  });

  it("falls back to the miss rate when a provider has no distinct write price", () => {
    const result = calculateUsageCost("deepseek", "deepseek-v4-flash", {
      promptTokens: 1_000_000,
      promptCacheHitTokens: 400_000,
      promptCacheMissTokens: 600_000,
      cacheCreationTokens: 200_000,
      completionTokens: 0,
    });

    expect(result?.cost).toBeCloseTo(0.4 * 0.0028 + 0.6 * 0.14);
  });

  it("prices a cached Opus run far below an uncached one", () => {
    const uncached = calculateUsageCost("anthropic", "claude-opus-4-8", {
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    const cached = calculateUsageCost("anthropic", "claude-opus-4-8", {
      promptTokens: 1_000_000,
      promptCacheHitTokens: 900_000,
      promptCacheMissTokens: 100_000,
      cacheCreationTokens: 90_000,
      completionTokens: 0,
    });

    expect(uncached!.cost).toBeCloseTo(5);
    expect(cached!.cost).toBeLessThan(uncached!.cost / 3);
  });
});

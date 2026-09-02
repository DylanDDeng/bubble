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

  it("contains current DeepSeek v4 peak/off-peak pricing", () => {
    expect(getModelPricing("deepseek", "deepseek-v4-flash")).toMatchObject({
      inputCacheHitPerMillion: 0.014,
      inputCacheMissPerMillion: 0.44,
      outputPerMillion: 1.32,
      offPeak: {
        inputCacheHitPerMillion: 0.007,
        inputCacheMissPerMillion: 0.22,
        outputPerMillion: 0.66,
      },
    });
    expect(getModelPricing("deepseek", "deepseek-v4-pro")).toMatchObject({
      inputCacheHitPerMillion: 0.044,
      inputCacheMissPerMillion: 1.32,
      outputPerMillion: 3.96,
      offPeak: {
        inputCacheHitPerMillion: 0.022,
        inputCacheMissPerMillion: 0.66,
        outputPerMillion: 1.98,
      },
    });
    expect(getModelPricing("deepseek", "deepseek-v4-flash-vision-exp")).toMatchObject({
      inputCacheHitPerMillion: 0.014,
      inputCacheMissPerMillion: 0.44,
      outputPerMillion: 1.32,
    });
  });

  it("contains StepFun step-3.7-flash CNY pricing", () => {
    expect(getModelPricing("stepfun", "step-3.7-flash")).toMatchObject({
      currency: "CNY",
      inputCacheHitPerMillion: 0.27,
      inputCacheMissPerMillion: 1.35,
      outputPerMillion: 8.1,
    });
  });

  it("prices Gemini 3.7/3.8 Flash across the launch-promo boundary", () => {
    for (const modelId of ["gemini-3.7-flash", "gemini-3.8-flash"]) {
      const usage = {
        promptTokens: 1_000_000,
        promptCacheHitTokens: 250_000,
        promptCacheMissTokens: 750_000,
        completionTokens: 1_000_000,
      };
      expect(calculateUsageCost("google", modelId, usage, new Date("2026-12-31T23:59:59Z")))
        .toEqual({ currency: "USD", cost: 0.25 * 0.075 + 0.75 * 0.75 + 3.75, estimated: false });
      expect(calculateUsageCost("google", modelId, usage, new Date("2027-01-01T00:00:00Z")))
        .toEqual({ currency: "USD", cost: 0.25 * 0.15 + 0.75 * 1.5 + 7.5, estimated: false });
    }
  });

  it("calculates DeepSeek cache-aware cost", () => {
    const result = calculateUsageCost("deepseek", "deepseek-v4-pro", {
      promptTokens: 1_000_000,
      promptCacheHitTokens: 250_000,
      promptCacheMissTokens: 750_000,
      completionTokens: 500_000,
    }, new Date("2026-08-21T02:00:00Z"));

    expect(result).toEqual({
      currency: "USD",
      cost: 0.25 * 0.044 + 0.75 * 1.32 + 0.5 * 3.96,
      estimated: false,
    });
  });

  it("uses the DeepSeek off-peak tariff outside the UTC peak windows", () => {
    const result = calculateUsageCost("deepseek", "deepseek-v4-flash", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    }, new Date("2026-08-21T05:00:00Z"));
    expect(result?.currency).toBe("USD");
    expect(result?.estimated).toBe(true);
    expect(result?.cost).toBeCloseTo(0.88);
  });

  it("does not reprice DeepSeek sessions from before the tariff change", () => {
    const result = calculateUsageCost("deepseek", "deepseek-v4-flash", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    }, new Date("2026-08-16T15:59:59Z"));

    expect(result?.cost).toBeCloseTo(0.14 + 0.28);
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
    }, new Date("2026-08-21T05:00:00Z"));

    expect(result?.cost).toBeCloseTo(0.4 * 0.007 + 0.6 * 0.22);
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

  it("uses Sonnet 5 post-promo cache-write pricing after expiry", () => {
    const result = calculateUsageCost("anthropic", "claude-sonnet-5", {
      promptTokens: 1_000_000,
      promptCacheMissTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      completionTokens: 0,
    }, new Date("2026-09-01T00:00:00Z"));

    expect(result).toEqual({ currency: "USD", cost: 3.75, estimated: false });
  });
});

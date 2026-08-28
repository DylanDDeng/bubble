import { describe, expect, it } from "vitest";
import { GENERATED_MODEL_DATA } from "../model-data.generated.js";
import { MODEL_PRICING, MODEL_PRICING_OVERRIDES, getModelPricing } from "../model-pricing.js";
import { BUILTIN_MODELS } from "../model-catalog.js";

describe("generated model data", () => {
  it("has a non-trivial snapshot", () => {
    expect(GENERATED_MODEL_DATA.length).toBeGreaterThan(100);
  });

  it("prices models the hand-written table never covered", () => {
    expect(getModelPricing("moonshot-cn", "kimi-k2.7-code")).toMatchObject({
      currency: "USD",
      inputCacheHitPerMillion: 0.19,
      inputCacheMissPerMillion: 0.95,
      outputPerMillion: 4,
    });
    expect(getModelPricing("minimax", "MiniMax-M3")).toBeDefined();
    expect(getModelPricing("minimax-anthropic", "MiniMax-M3")).toBeDefined();
    expect(getModelPricing("zhipuai", "glm-5.2")).toBeDefined();
    expect(getModelPricing("anthropic", "claude-haiku-4-5-20251001")).toBeDefined();
  });

  it("keeps subscription plans unpriced instead of showing $0", () => {
    expect(getModelPricing("zai-coding-plan", "glm-5.2")).toBeUndefined();
    expect(getModelPricing("zhipuai-coding-plan", "glm-5.3-flash")).toBeUndefined();
    expect(getModelPricing("kimi-for-coding", "kimi-k2.7-code")).toBeUndefined();
    expect(getModelPricing("openai-codex", "gpt-5.6-sol")).toBeUndefined();
  });

  it("lets overrides shadow generated entries exactly once", () => {
    for (const override of MODEL_PRICING_OVERRIDES) {
      const matches = MODEL_PRICING.filter(
        (item) => item.providerId === override.providerId && item.modelId === override.modelId,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(override);
    }
    // The StepFun CNY override wins over the USD entry models.dev normalizes to.
    expect(getModelPricing("stepfun", "step-3.7-flash")?.currency).toBe("CNY");
    // The Sonnet 5 promo metadata survives regeneration.
    expect(getModelPricing("anthropic", "claude-sonnet-5")?.effectiveUntil).toBeDefined();
  });

  it("contains no duplicate (provider, model) pricing rows", () => {
    const keys = MODEL_PRICING.map((item) => `${item.providerId} ${item.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps builtin catalog context windows within 25% of models.dev", () => {
    // Guards against catalog rot: a builtin entry drifting far from the
    // upstream catalog (wrong by 4x, stale after a model refresh) fails here.
    // Small disagreements (1_000_000 vs 1_048_576) are expected and pass.
    const generated = new Map(
      GENERATED_MODEL_DATA.map((entry) => [`${entry.providerId} ${entry.modelId}`, entry]),
    );
    const drifted: string[] = [];
    for (const model of BUILTIN_MODELS) {
      if (model.contextWindow === undefined) continue;
      const upstream = generated.get(`${model.providerId} ${model.id}`);
      if (!upstream?.contextWindow) continue;
      const ratio = model.contextWindow / upstream.contextWindow;
      if (ratio > 1.25 || ratio < 0.8) {
        drifted.push(
          `${model.providerId}/${model.id}: catalog ${model.contextWindow} vs models.dev ${upstream.contextWindow}`,
        );
      }
    }
    expect(drifted).toEqual([]);
  });
});

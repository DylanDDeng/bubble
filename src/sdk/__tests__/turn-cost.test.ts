import { describe, expect, it } from "vitest";
import { attachTurnCost } from "../index.js";
import type { AgentEvent, TokenUsage } from "../../types.js";

const usage: TokenUsage = {
  promptTokens: 1_000_000,
  completionTokens: 500_000,
  promptCacheHitTokens: 400_000,
  promptCacheMissTokens: 600_000,
};

describe("attachTurnCost", () => {
  it("prices a turn_end event for a model with a pricing entry", () => {
    const event: AgentEvent = { type: "turn_end", usage, willContinue: false };
    const enriched = attachTurnCost(event, "deepseek", "deepseek-v4-flash");

    expect(enriched.type).toBe("turn_end");
    if (enriched.type !== "turn_end") return;
    expect(enriched.cost).toEqual({
      currency: "USD",
      cost: 0.4 * 0.0028 + 0.6 * 0.14 + 0.5 * 0.28,
      estimated: false,
    });
    // The original event stays untouched — enrichment returns a copy.
    expect(event.cost).toBeUndefined();
  });

  it("passes through turn_end for unpriced models", () => {
    const event: AgentEvent = { type: "turn_end", usage, willContinue: false };
    expect(attachTurnCost(event, "local", "deepseek-coder-v2")).toBe(event);
  });

  it("passes through turn_end without usage", () => {
    const event: AgentEvent = { type: "turn_end", willContinue: false };
    expect(attachTurnCost(event, "deepseek", "deepseek-v4-flash")).toBe(event);
  });

  it("ignores non-turn_end events", () => {
    const event: AgentEvent = { type: "text_delta", content: "hi" };
    expect(attachTurnCost(event, "deepseek", "deepseek-v4-flash")).toBe(event);
  });

  it("marks the cost as estimated when the provider gave no cache breakdown", () => {
    const event: AgentEvent = {
      type: "turn_end",
      usage: { promptTokens: 1_000_000, completionTokens: 0 },
      willContinue: true,
    };
    const enriched = attachTurnCost(event, "deepseek", "deepseek-v4-pro");
    if (enriched.type !== "turn_end") return;
    expect(enriched.cost?.estimated).toBe(true);
    expect(enriched.cost?.cost).toBeCloseTo(0.435);
  });
});

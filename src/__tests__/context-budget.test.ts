import { describe, expect, it } from "vitest";
import { estimateContextTokens, getContextBudget } from "../context/budget.js";
import type { Message } from "../types.js";

describe("context budget", () => {
  it("estimates tokens from message content", () => {
    const messages: Message[] = [
      { role: "system", content: "system instruction" },
      { role: "user", content: "hello world" },
      { role: "assistant", content: "reply" },
    ];

    expect(estimateContextTokens(messages)).toBeGreaterThan(0);
  });

  it("uses model catalog context windows when available", () => {
    const messages: Message[] = [
      { role: "user", content: "x".repeat(4000) },
    ];

    const budget = getContextBudget("openai-codex", "gpt-5.4", messages);
    expect(budget.contextWindow).toBe(272000);
    expect(budget.percent).toBeDefined();
  });

  it("flags prune and compact thresholds as usage grows", () => {
    const messages: Message[] = [
      { role: "user", content: "x".repeat(450000) },
    ];

    const budget = getContextBudget("openai", "gpt-4o", messages);
    expect(budget.shouldPrune).toBe(true);
    expect(budget.shouldCompact).toBe(true);
  });
});

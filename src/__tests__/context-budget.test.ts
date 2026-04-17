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

  it("uses fixed-reserve threshold on a large window", () => {
    // 272k - 20k output - 13k buffer = 239k compact threshold
    // 272k - 20k output - 50k buffer = 202k prune threshold
    const smallMessages: Message[] = [{ role: "user", content: "x".repeat(800_000) }]; // ~200k tokens
    const budgetSmall = getContextBudget("openai-codex", "gpt-5.4", smallMessages);
    expect(budgetSmall.shouldCompact).toBe(false);
    expect(budgetSmall.shouldPrune).toBe(false);

    const bigMessages: Message[] = [{ role: "user", content: "x".repeat(1_000_000) }]; // ~250k tokens
    const budgetBig = getContextBudget("openai-codex", "gpt-5.4", bigMessages);
    expect(budgetBig.shouldCompact).toBe(true);
    expect(budgetBig.shouldPrune).toBe(true);
  });

  it("respects usage anchor from response when provided", () => {
    const messages: Message[] = [
      { role: "user", content: "old turn" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new turn" },
    ];
    // Server says 200k tokens already used after message 2.
    // Tail is just message 3 (small). Total ~= 200k, above 272k's 239k compact threshold? No, 200 < 239.
    // Use 245k anchor instead to cross the threshold.
    const budget = getContextBudget("openai-codex", "gpt-5.4", messages, {
      usageAnchorTokens: 245_000,
      tailMessages: messages.slice(2),
    });
    expect(budget.estimatedTokens).toBeGreaterThan(245_000);
    expect(budget.shouldCompact).toBe(true);
  });
});

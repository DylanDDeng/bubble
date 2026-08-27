import { describe, expect, it, beforeEach } from "vitest";
import { truncateToolOutputForModel } from "../context/tool-output-truncate.js";
import { registerDynamicModelMetadata } from "../model-catalog.js";

describe("truncateToolOutputForModel", () => {
  beforeEach(() => {
    registerDynamicModelMetadata({
      id: "test-model",
      name: "test-model",
      providerId: "openai-codex",
      reasoningLevels: ["off"],
      contextWindow: 272_000,
      toolOutputTokenLimit: 1000,
    });
  });

  it("returns the original content unchanged when under the limit", () => {
    const small = "hello world";
    const result = truncateToolOutputForModel(small, "openai-codex", "test-model");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(small);
    expect(result.limit).toBe(1000);
  });

  it("middle-truncates when content exceeds the model's token cap", () => {
    // "x".repeat(50000) → heuristic 12500 tokens (well above the 1000 cap).
    const huge = "HEAD-MARKER\n" + "x".repeat(50000) + "\nTAIL-MARKER";
    const result = truncateToolOutputForModel(huge, "openai-codex", "test-model");

    expect(result.truncated).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(1000);
    // Head and tail markers must survive (middle is what gets dropped).
    expect(result.content).toContain("HEAD-MARKER");
    expect(result.content).toContain("TAIL-MARKER");
    expect(result.content).toContain("truncated by model policy");
  });

  it("applies the generic byte cap when the model has no declared token limit", () => {
    registerDynamicModelMetadata({
      id: "uncapped-model",
      name: "uncapped-model",
      providerId: "openai-codex",
      reasoningLevels: ["off"],
      contextWindow: 100_000,
      // no toolOutputTokenLimit
    });
    const big = "x".repeat(100_000);
    const result = truncateToolOutputForModel(big, "openai-codex", "uncapped-model");
    expect(result.truncated).toBe(true);
    expect(result.finalBytes).toBeLessThanOrEqual(64 * 1024);
    expect(result.limit).toBeUndefined();
  });

  it("keeps byte truncation valid UTF-8 for CJK and emoji", () => {
    registerDynamicModelMetadata({
      id: "utf8-model",
      name: "utf8-model",
      providerId: "openai-codex",
      reasoningLevels: ["off"],
      contextWindow: 100_000,
    });
    const big = `开头🙂${"内容🚀".repeat(20_000)}结尾✅`;
    const result = truncateToolOutputForModel(big, "openai-codex", "utf8-model");
    expect(result.truncated).toBe(true);
    expect(result.finalBytes).toBeLessThanOrEqual(64 * 1024);
    expect(result.content).not.toContain("�");
    expect(result.content).toContain("开头🙂");
    expect(result.content).toContain("结尾✅");
  });

  it("falls through openai → openai-codex catalog lookup for OAuth provider", () => {
    // Real codebase scenario: provider id is "openai" but the model lives in
    // the "openai-codex" overlay (set up in beforeEach). The lookup should
    // still find the limit.
    const big = "y".repeat(50_000);
    const result = truncateToolOutputForModel(big, "openai", "test-model");
    expect(result.truncated).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(1000);
  });
});

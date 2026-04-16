import { describe, expect, it } from "vitest";
import { resolveProviderRequestConfig } from "../provider-transform.js";

describe("provider transform", () => {
  it("does not emit explicit reasoning for ChatGPT OAuth codex", () => {
    const config = resolveProviderRequestConfig("openai-codex", "gpt-5.4", "high");
    expect(config.effectiveThinkingLevel).toBe("high");
    expect(config.reasoningEffort).toBeUndefined();
  });

  it("emits reasoning effort for openai-compatible providers", () => {
    const openai = resolveProviderRequestConfig("openai", "o1-preview", "high");
    const google = resolveProviderRequestConfig("google", "gemini-2.5-pro-preview-03-25", "high");

    expect(openai.reasoningEffort).toBe("high");
    expect(google.reasoningEffort).toBe("high");
  });

  it("keeps unsupported providers at UI-only thinking state", () => {
    const config = resolveProviderRequestConfig("deepseek", "deepseek-chat", "high");
    expect(config.effectiveThinkingLevel).toBe("off");
    expect(config.reasoningEffort).toBeUndefined();
  });
});

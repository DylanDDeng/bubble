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

  it("emits Zhipu/Z.AI thinking config for coding-plan compatible providers", () => {
    const zhipu = resolveProviderRequestConfig("zhipuai-coding-plan", "glm-5.1", "medium");
    const zai = resolveProviderRequestConfig("zai-coding-plan", "glm-5-turbo", "medium");

    expect(zhipu.reasoningEffort).toBeUndefined();
    expect(zhipu.extraBody).toEqual({
      thinking: {
        type: "enabled",
        clear_thinking: false,
      },
    });
    expect(zai.extraBody).toEqual({
      thinking: {
        type: "enabled",
        clear_thinking: false,
      },
    });
  });

  it("does not emit Zhipu/Z.AI thinking config when thinking is off", () => {
    const config = resolveProviderRequestConfig("zhipuai", "glm-4.7", "off");
    expect(config.effectiveThinkingLevel).toBe("off");
    expect(config.extraBody).toBeUndefined();
  });

  it("keeps unsupported providers at UI-only thinking state", () => {
    const config = resolveProviderRequestConfig("deepseek", "deepseek-chat", "high");
    expect(config.effectiveThinkingLevel).toBe("off");
    expect(config.reasoningEffort).toBeUndefined();
  });

  it("emits DeepSeek v4 pro thinking and reasoning effort fields", () => {
    const config = resolveProviderRequestConfig("deepseek", "deepseek-v4-pro", "max");

    expect(config.effectiveThinkingLevel).toBe("max");
    expect(config.reasoningEffort).toBeUndefined();
    expect(config.reasoningContentEcho).toBe("all");
    expect(config.extraBody).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });
});

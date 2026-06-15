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
    const config = resolveProviderRequestConfig("deepseek", "unknown-model", "high");
    expect(config.effectiveThinkingLevel).toBe("off");
    expect(config.reasoningEffort).toBeUndefined();
  });

  it("emits DeepSeek v4 thinking and reasoning effort fields", () => {
    const config = resolveProviderRequestConfig("deepseek", "deepseek-v4-pro", "max");
    const flash = resolveProviderRequestConfig("deepseek", "deepseek-v4-flash", "high");

    expect(config.effectiveThinkingLevel).toBe("max");
    expect(config.reasoningEffort).toBeUndefined();
    expect(config.reasoningContentEcho).toBe("all");
    expect(config.extraBody).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(flash.extraBody).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("emits StepFun Step Plan reasoning effort fields", () => {
    const high = resolveProviderRequestConfig("stepfun", "step-3.7-flash", "high");
    const off = resolveProviderRequestConfig("stepfun", "step-3.5-flash", "off");

    expect(high.effectiveThinkingLevel).toBe("high");
    expect(high.reasoningEffort).toBeUndefined();
    expect(high.reasoningContentEcho).toBe("none");
    expect(high.extraBody).toEqual({ reasoning_effort: "high" });
    expect(off.extraBody).toBeUndefined();
  });

  it("emits MiniMax interleaved thinking request fields", () => {
    const m3 = resolveProviderRequestConfig("minimax-openai", "MiniMax-M3", "medium");
    const m27 = resolveProviderRequestConfig("minimax-openai", "MiniMax-M2.7", "medium");
    const off = resolveProviderRequestConfig("minimax-openai", "MiniMax-M3", "off");

    expect(m3.reasoningContentEcho).toBe("minimax");
    expect(m3.extraBody).toEqual({
      reasoning_split: true,
      thinking: { type: "adaptive" },
    });
    expect(m27.extraBody).toEqual({ reasoning_split: true });
    expect(off.extraBody).toEqual({
      reasoning_split: true,
      thinking: { type: "disabled" },
    });
  });

  it("locks kimi-k2.7-code to thinking-only with temperature omitted", () => {
    const cn = resolveProviderRequestConfig("moonshot-cn", "kimi-k2.7-code", "medium");
    const intl = resolveProviderRequestConfig("moonshot-intl", "kimi-k2.7-code", "off");

    // Thinking can never be disabled, so even an "off" request normalizes to medium.
    expect(cn.effectiveThinkingLevel).toBe("medium");
    expect(intl.effectiveThinkingLevel).toBe("medium");
    expect(cn.omitTemperature).toBe(true);
    expect(cn.reasoningContentEcho).toBe("tool_calls");
    expect(cn.extraBody).toEqual({ thinking: { type: "enabled" } });
    expect(intl.extraBody).toEqual({ thinking: { type: "enabled" } });
  });

  it("uses Fireworks Kimi agent defaults", () => {
    const config = resolveProviderRequestConfig("fireworks", "accounts/fireworks/models/kimi-k2p6", "off");

    expect(config.effectiveThinkingLevel).toBe("off");
    expect(config.reasoningContentEcho).toBe("none");
    expect(config.parallelToolCalls).toBe(false);
    expect(config.maxTokens).toBe(32768);
  });

  it("does not disable parallel tool calls outside Fireworks Kimi", () => {
    const moonshot = resolveProviderRequestConfig("moonshot-cn", "kimi-k2.6", "off");
    const fireworksOther = resolveProviderRequestConfig("fireworks", "accounts/fireworks/models/llama-v3p1-405b-instruct", "off");
    const openai = resolveProviderRequestConfig("openai", "gpt-4o", "off");

    expect(moonshot.parallelToolCalls).toBeUndefined();
    expect(fireworksOther.parallelToolCalls).toBeUndefined();
    expect(openai.parallelToolCalls).toBeUndefined();
  });
});

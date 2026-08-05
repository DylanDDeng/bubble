import { describe, expect, it } from "vitest";
import { resolveProviderRequestConfig } from "../provider-transform.js";

describe("provider transform", () => {
  it("emits only supported non-off reasoning effort for ChatGPT OAuth codex", () => {
    const high = resolveProviderRequestConfig("openai-codex", "gpt-5.6-sol", "high");
    const ultra = resolveProviderRequestConfig("openai-codex", "gpt-5.6-sol", "ultra");

    expect(high.effectiveThinkingLevel).toBe("high");
    expect(high.reasoningEffort).toBe("high");
    expect(ultra.effectiveThinkingLevel).toBe("ultra");
    expect(ultra.reasoningEffort).toBe("ultra");
  });

  it("defensively falls stale Codex state back to the model default", () => {
    const sol = resolveProviderRequestConfig("openai-codex", "gpt-5.6-sol", "off");
    const terra = resolveProviderRequestConfig("openai-codex", "gpt-5.6-terra", "minimal");
    const luna = resolveProviderRequestConfig("openai-codex", "gpt-5.6-luna", "ultra");

    expect(sol).toMatchObject({ effectiveThinkingLevel: "low", reasoningEffort: "low" });
    expect(terra).toMatchObject({ effectiveThinkingLevel: "medium", reasoningEffort: "medium" });
    expect(luna).toMatchObject({ effectiveThinkingLevel: "medium", reasoningEffort: "medium" });
  });

  it("omits Codex reasoning when model capabilities are unknown or effective effort is off", () => {
    const unknown = resolveProviderRequestConfig("openai-codex", "gpt-future-unknown", "high");
    const legacyOff = resolveProviderRequestConfig("openai-codex", "gpt-5.4", "off");

    expect(unknown.effectiveThinkingLevel).toBe("off");
    expect(unknown.reasoningEffort).toBeUndefined();
    expect(legacyOff.effectiveThinkingLevel).toBe("off");
    expect(legacyOff.reasoningEffort).toBeUndefined();
  });

  it("emits reasoning effort for openai-compatible providers", () => {
    const openai = resolveProviderRequestConfig("openai", "o1-preview", "high");
    const google = resolveProviderRequestConfig("google", "gemini-2.5-pro", "high");

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

  it("emits GLM-5.2 reasoning_effort (high/max) alongside the thinking block", () => {
    const max = resolveProviderRequestConfig("zhipuai", "glm-5.2", "max");
    const high = resolveProviderRequestConfig("zai-coding-plan", "glm-5.2", "high");

    expect(max.reasoningEffort).toBeUndefined();
    expect(max.extraBody).toEqual({
      thinking: { type: "enabled", clear_thinking: false },
      reasoning_effort: "max",
    });
    expect(high.extraBody).toEqual({
      thinking: { type: "enabled", clear_thinking: false },
      reasoning_effort: "high",
    });
  });

  it("disables GLM-5.2 thinking when level is off (no effort sent)", () => {
    const config = resolveProviderRequestConfig("zhipuai", "glm-5.2", "off");
    expect(config.effectiveThinkingLevel).toBe("off");
    expect(config.extraBody).toEqual({ thinking: { type: "disabled" } });
  });

  it("clamps unsupported GLM-5.2 levels down to nearest supported (off)", () => {
    // clampThinkingLevel walks downward; with off/high/max supported, "low"
    // and "medium" land on "off".
    expect(resolveProviderRequestConfig("zhipuai", "glm-5.2", "low").effectiveThinkingLevel).toBe("off");
    expect(resolveProviderRequestConfig("zhipuai", "glm-5.2", "medium").effectiveThinkingLevel).toBe("off");
    // xhigh sits between high and max → clamps down to high.
    expect(resolveProviderRequestConfig("zhipuai", "glm-5.2", "xhigh").effectiveThinkingLevel).toBe("high");
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

  it("keeps Doubao Chat-compatible reasoning effort fields for explicit openai-chat overrides", () => {
    const minimal = resolveProviderRequestConfig("doubao", "doubao-seed-2-1-pro-260628", "minimal");
    const low = resolveProviderRequestConfig("doubao", "doubao-seed-2-1-pro-260628", "low");
    const medium = resolveProviderRequestConfig("doubao", "doubao-seed-2-1-pro-260628", "medium");
    const high = resolveProviderRequestConfig("doubao", "doubao-seed-2-1-pro-260628", "high");

    expect(minimal.effectiveThinkingLevel).toBe("minimal");
    expect(minimal.reasoningEffort).toBeUndefined();
    expect(minimal.parallelToolCalls).toBe(false);
    expect(minimal.extraBody).toEqual({ reasoning_effort: "minimal" });
    expect(low.extraBody).toEqual({ reasoning_effort: "low" });
    expect(medium.extraBody).toEqual({ reasoning_effort: "medium" });
    expect(high.extraBody).toEqual({ reasoning_effort: "high" });
  });

  it("locks Kimi K2.7 Code variants to thinking-only with temperature omitted", () => {
    const cn = resolveProviderRequestConfig("moonshot-cn", "kimi-k2.7-code", "medium");
    const intl = resolveProviderRequestConfig("moonshot-intl", "kimi-k2.7-code", "off");
    const highspeed = resolveProviderRequestConfig("kimi-for-coding", "kimi-k2.7-code-highspeed", "off");

    // Thinking can never be disabled, so even an "off" request normalizes to medium.
    expect(cn.effectiveThinkingLevel).toBe("medium");
    expect(intl.effectiveThinkingLevel).toBe("medium");
    expect(highspeed.effectiveThinkingLevel).toBe("medium");
    expect(cn.omitTemperature).toBe(true);
    expect(highspeed.omitTemperature).toBe(true);
    expect(cn.reasoningContentEcho).toBe("tool_calls");
    expect(cn.extraBody).toEqual({ thinking: { type: "enabled" } });
    expect(intl.extraBody).toEqual({ thinking: { type: "enabled" } });
    expect(highspeed.extraBody).toEqual({ thinking: { type: "enabled" } });
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

describe("Kimi K3 request shape", () => {
  it("sends OpenAI-style reasoning_effort for graded levels", () => {
    for (const [providerId, modelId] of [
      ["kimi-for-coding", "k3"],
      ["kimi-for-coding", "k3-256k"],
      ["moonshot-cn", "kimi-k3"],
    ] as const) {
      const config = resolveProviderRequestConfig(providerId, modelId, "max");
      // Must be the literal body field, not the OpenRouter-shaped
      // `reasoningEffort` (which the chat path degrades to reasoning.enabled).
      expect(config.extraBody).toEqual({ reasoning_effort: "max" });
      expect(config.reasoningEffort).toBeUndefined();
      expect(config.omitTemperature).toBe(true);
    }
  });

  it("disables thinking via thinking.type for k3 (which supports off)", () => {
    const config = resolveProviderRequestConfig("kimi-for-coding", "k3", "off");
    expect(config.effectiveThinkingLevel).toBe("off");
    expect(config.reasoningEffort).toBeUndefined();
    expect(config.extraBody).toEqual({ thinking: { type: "disabled" } });
  });

  it("normalizes an unsupported level onto the model's own grades", () => {
    // K3 has no "medium"; k3-256k additionally has no "off".
    expect(resolveProviderRequestConfig("kimi-for-coding", "k3", "medium").extraBody)
      .not.toEqual({ reasoning_effort: "medium" });
    expect(resolveProviderRequestConfig("kimi-for-coding", "k3-256k", "off").effectiveThinkingLevel)
      .not.toBe("off");
  });

  it("keeps coding-plan slot ids on the thinking-only K2.7 shape", () => {
    const config = resolveProviderRequestConfig("kimi-for-coding", "kimi-for-coding", "high");
    expect(config.extraBody).toEqual({ thinking: { type: "enabled" } });
    expect(config.reasoningEffort).toBeUndefined();
  });
});

describe("Bailian token plan request shape", () => {
  it("sends reasoning_effort for graded levels", () => {
    const config = resolveProviderRequestConfig("bailian-token-plan", "qwen3.8-max", "xhigh");
    expect(config.extraBody).toEqual({ reasoning_effort: "xhigh" });
  });

  it('maps "off" to the endpoint\'s "none" value', () => {
    const config = resolveProviderRequestConfig("bailian-token-plan", "qwen3.8-max", "off");
    expect(config.extraBody).toEqual({ reasoning_effort: "none" });
  });

  it("normalizes onto each model's own server-validated ladder", () => {
    // qwen3.6-flash tops out at xhigh; deepseek-v4-pro there has no off.
    expect(resolveProviderRequestConfig("bailian-token-plan", "qwen3.6-flash", "max").extraBody)
      .not.toEqual({ reasoning_effort: "max" });
    expect(resolveProviderRequestConfig("bailian-token-plan", "deepseek-v4-pro", "off").extraBody)
      .not.toEqual({ reasoning_effort: "none" });
  });
});

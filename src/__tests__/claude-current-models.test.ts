import { describe, expect, it } from "vitest";
import { BUILTIN_MODELS, getBuiltinModel } from "../model-catalog.js";
import { buildAnthropicRequest, translateAnthropicStream } from "../provider-anthropic.js";
import { calculateUsageCost } from "../model-pricing.js";
import { getDefaultThinkingLevel } from "../variant/variant-resolver.js";
import type { ProviderRawContentBlock, ToolDefinition } from "../types.js";

const options = { providerId: "anthropic", apiKey: "fixture", baseURL: "https://api.anthropic.com" };
const tools: ToolDefinition[] = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
const user = { role: "user" as const, content: "Read the file" };

describe("current public Claude models", () => {
  it("exposes the new lineup with model-specific defaults and reasoning controls", () => {
    for (const model of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-opus-5"]) {
      expect(BUILTIN_MODELS.some((entry) => entry.providerId === "anthropic" && entry.id === model)).toBe(true);
      expect(getBuiltinModel("anthropic", model)?.contextWindow).toBe(1_000_000);
      expect(getBuiltinModel("anthropic", model)?.reasoningLevels).toContain("xhigh");
    }
    expect(getDefaultThinkingLevel("anthropic", "claude-opus-5-5")).toBe("medium");
    expect(getDefaultThinkingLevel("anthropic", "claude-fable-5-1")).toBe("high");
  });

  it.each(["claude-fable-5-1", "claude-opus-5-5"])("builds valid always-on requests for %s", (model) => {
    expect(getBuiltinModel("anthropic", model)?.reasoningLevels).not.toContain("off");
    for (const thinkingLevel of ["off", "low", "medium", "high", "xhigh", "max"] as const) {
      const body = buildAnthropicRequest(options, [user], { model, tools, toolChoice: "auto", thinkingLevel, temperature: 0.2 });
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(body.output_config).toEqual({ effort: thinkingLevel === "off" ? "low" : thinkingLevel });
      expect(body.tool_choice).toEqual({ type: "auto" });
      expect(body.max_tokens).toBe(128000);
      expect(body).not.toHaveProperty("temperature");
    }
    expect(buildAnthropicRequest(options, [user], { model, tools, toolChoice: "none" }).tool_choice).toEqual({ type: "none" });
    expect(buildAnthropicRequest(options, [user], { model }).output_config).toEqual({ effort: model === "claude-opus-5-5" ? "medium" : "high" });
  });

  it.each(["claude-sonnet-5", "claude-opus-5"])("explicitly disables default-on thinking for %s", (model) => {
    const body = buildAnthropicRequest(options, [user], { model, thinkingLevel: "off", temperature: 0.2 });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(128000);
    expect(buildAnthropicRequest(options, [user], { model, thinkingLevel: "xhigh" }).output_config).toEqual({ effort: "xhigh" });
  });

  it.each(["claude-fable-5-1", "claude-opus-5-5"])("round-trips empty signed thinking through a %s tool loop", async (model) => {
    async function* events() {
      yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-empty-block" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read", input: {} } };
      yield { type: "content_block_stop", index: 1 };
    }
    const contentBlocks: ProviderRawContentBlock[] = [];
    for await (const chunk of translateAnthropicStream(events())) {
      if (chunk.type === "provider_content_block") contentBlocks.push(chunk.block);
    }
    const before = JSON.stringify(contentBlocks);
    const body = buildAnthropicRequest(options, [user, {
      role: "assistant", content: "", reasoning: "sanitized display text",
      providerMetadata: { anthropic: { contentBlocks } },
    }, { role: "tool", toolCallId: "call_1", content: "file contents" }], { model, tools });
    expect(body.messages[1].content).toEqual(contentBlocks);
    expect(body.messages[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "signed-empty-block" });
    expect(JSON.stringify(contentBlocks)).toBe(before);
  });

  it("never fabricates unsigned thinking from display text for new Claude tool loops", () => {
    const body = buildAnthropicRequest(options, [user, {
      role: "assistant", content: "", reasoning: "display only",
      toolCalls: [{ id: "call_1", name: "read", arguments: "{}" }],
    }, { role: "tool", toolCallId: "call_1", content: "ok" }], { model: "claude-opus-5-5", tools });
    expect(body.messages[1].content).toEqual([{ type: "tool_use", id: "call_1", name: "read", input: {} }]);
  });

  it.each([
    ["claude-fable-5-1", 0.25], ["claude-opus-5-5", 0.2],
  ] as const)("uses the reduced cache-read price for %s", (model, cost) => {
    expect(calculateUsageCost("anthropic", model, {
      promptTokens: 1_000_000, promptCacheHitTokens: 1_000_000,
      promptCacheMissTokens: 0, completionTokens: 0,
    })).toEqual({ currency: "USD", cost, estimated: false });
  });
});

import { describe, expect, it } from "vitest";
import { ProviderRegistry, displayModel, normalizeModel } from "../provider-registry.js";

describe("provider registry", () => {
  it("normalizes provider-less models to openai by default", () => {
    expect(normalizeModel("gpt-4o")).toBe("openai:gpt-4o");
  });

  it("uses built-in display names for encoded models", () => {
    expect(displayModel("fireworks:accounts/fireworks/models/kimi-k2p6")).toBe("Kimi-K2.6");
    expect(displayModel("alibaba:qwen3.7-max")).toBe("Qwen3.7 Max");
    expect(displayModel("stepfun:step-3.7-flash")).toBe("Step 3.7 Flash");
    expect(displayModel("minimax:MiniMax-M3")).toBe("MiniMax M3");
    expect(displayModel("minimax-anthropic:MiniMax-M3")).toBe("MiniMax M3");
    expect(displayModel("anthropic:claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });

  it("prefers user-visible providers over hidden openrouter defaults", () => {
    const providers = [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "or-key",
        enabled: true,
        authType: "api",
      },
      {
        id: "openai",
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        apiKey: "oa-key",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "openrouter",
      setDefaultProvider: () => undefined,
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultModel: () => undefined,
      getRecentModels: () => [],
      pushRecentModel: () => undefined,
    } as any;

    const registry = new ProviderRegistry(config);
    expect(registry.getDefault()?.id).toBe("openai");
  });

  it("overlays built-in protocol metadata onto configured providers", () => {
    const providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "sk-ant",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "anthropic",
      setDefaultProvider: () => undefined,
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultModel: () => undefined,
      getRecentModels: () => [],
      pushRecentModel: () => undefined,
    } as any;

    const registry = new ProviderRegistry(config);
    expect(registry.getDefault()).toMatchObject({
      id: "anthropic",
      protocol: "anthropic-messages",
    });
  });
});

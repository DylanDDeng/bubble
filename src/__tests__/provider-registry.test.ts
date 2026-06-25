import { describe, expect, it } from "vitest";
import { ProviderRegistry, displayModel, isUserVisibleProvider, normalizeModel } from "../provider-registry.js";

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
    expect(displayModel("doubao:doubao-seed-2-1-pro-260628")).toBe("Doubao Seed 2.1 Pro");
    expect(displayModel("anthropic:claude-fable-5")).toBe("Claude Fable 5");
    expect(displayModel("anthropic:claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });

  it("shows Doubao as a user-visible provider", () => {
    expect(isUserVisibleProvider("doubao")).toBe(true);
  });

  it("exposes MiniMax Token Plan and MiniMax API as visible providers", () => {
    expect(isUserVisibleProvider("minimax")).toBe(true);
    expect(isUserVisibleProvider("minimax-anthropic")).toBe(true);
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

  it("overlays Ark Responses protocol metadata onto configured Doubao providers", () => {
    const providers = [
      {
        id: "doubao",
        name: "Doubao",
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "ark-key",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "doubao",
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
      id: "doubao",
      protocol: "ark-responses",
    });
  });

  it("does not force Anthropic protocol onto MiniMax OpenAI-compatible overrides", () => {
    const providers = [
      {
        id: "minimax",
        name: "MiniMax",
        baseURL: "https://api.minimaxi.com/v1",
        apiKey: "sk-cp",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "minimax",
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
      id: "minimax",
      baseURL: "https://api.minimaxi.com/v1",
    });
    expect(registry.getDefault()?.protocol).toBeUndefined();
  });
});

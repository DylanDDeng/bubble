import { describe, expect, it } from "vitest";
import { ProviderRegistry, normalizeModel } from "../provider-registry.js";

describe("provider registry", () => {
  it("normalizes provider-less models to openai by default", () => {
    expect(normalizeModel("gpt-4o")).toBe("openai:gpt-4o");
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
});

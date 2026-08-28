import { describe, expect, it, vi } from "vitest";
import { discoverModelProviderGroups, localModelsForProvider } from "../tui/model-picker-data.js";

const openaiOAuthProvider = {
  id: "openai",
  name: "OpenAI",
  baseURL: "https://chatgpt.com/backend-api",
  apiKey: "token",
  enabled: true,
  authType: "oauth" as const,
};

function registryStub(overrides: Record<string, unknown> = {}) {
  return {
    getEnabled: () => [openaiOAuthProvider],
    getModelConfig: () => ({
      getCustomModels: () => [],
    }),
    listModels: async () => [],
    ...overrides,
  } as any;
}

describe("model picker data", () => {
  it("offers only Ox Alpha for the builtin OpenRouter provider", () => {
    const provider = {
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "or-key",
      enabled: true,
      authType: "api" as const,
    };
    const models = localModelsForProvider(registryStub(), provider);

    expect(models.map((model) => model.id)).toEqual(["stealth/ox-alpha"]);
    expect(models[0]).toMatchObject({
      name: "Ox Alpha",
      providerId: "openrouter",
      contextWindow: 1048576,
      reasoningLevels: ["low", "high", "max"],
      defaultReasoningLevel: "max",
    });
  });

  it("does not let custom OpenRouter models expand the fixed catalog", () => {
    const provider = {
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "or-key",
      enabled: true,
      authType: "api" as const,
    };
    const models = localModelsForProvider(registryStub({
      getModelConfig: () => ({
        getCustomModels: () => [
          { id: "some/other-model", name: "Other", providerId: "openrouter" },
          { id: "stealth/ox-alpha", name: "Custom Ox", providerId: "openrouter" },
        ],
      }),
    }), provider);

    expect(models.map((model) => model.id)).toEqual(["stealth/ox-alpha"]);
  });

  it("uses the OpenAI Codex fallback catalog for ChatGPT OAuth providers", () => {
    const models = localModelsForProvider(registryStub(), openaiOAuthProvider);

    expect(models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      providerId: "openai",
    });
  });

  it("offers DeepSeek V4 Flash Vision with complete static metadata", () => {
    const provider = {
      id: "deepseek",
      name: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-deepseek",
      enabled: true,
      authType: "api" as const,
    };
    const models = localModelsForProvider(registryStub(), provider);
    const vision = models.find((model) => model.id === "deepseek-v4-flash-vision-exp");

    expect(vision).toMatchObject({
      name: "DeepSeek-V4-Flash-Vision-Exp",
      providerId: "deepseek",
      contextWindow: 1048576,
      reasoningLevels: ["off", "low", "high", "max"],
      defaultReasoningLevel: "high",
    });
    expect(vision?.tier).toBeUndefined();
  });

  it("discovers remote models through the provider registry", async () => {
    const listModels = vi.fn(async () => [
      { id: "gpt-5.5", name: "GPT-5.5", providerId: "openai" },
    ]);

    const groups = await discoverModelProviderGroups(registryStub({ listModels }));

    expect(listModels).toHaveBeenCalledWith(openaiOAuthProvider);
    expect(groups).toEqual([{
      provider: openaiOAuthProvider,
      models: [{ id: "gpt-5.5", name: "GPT-5.5", providerId: "openai" }],
    }]);
  });

  it("falls back to local models when remote discovery fails", async () => {
    const groups = await discoverModelProviderGroups(registryStub({
      listModels: vi.fn(async () => {
        throw new Error("network down");
      }),
    }));

    expect(groups[0]?.models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      providerId: "openai",
    });
  });
});

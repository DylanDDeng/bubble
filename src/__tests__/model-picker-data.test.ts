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
  it("uses the OpenAI Codex fallback catalog for ChatGPT OAuth providers", () => {
    const models = localModelsForProvider(registryStub(), openaiOAuthProvider);

    expect(models[0]).toMatchObject({
      id: "gpt-5.5",
      providerId: "openai",
    });
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
      id: "gpt-5.5",
      providerId: "openai",
    });
  });
});

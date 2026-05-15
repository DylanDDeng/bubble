import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile, ProviderRegistry } from "../provider-registry.js";
import { buildLocalModelOptions } from "../tui-ink/model-picker.js";

describe("Ink model picker", () => {
  it("builds initial options from local metadata without remote model discovery", () => {
    const listModels = vi.fn(async () => {
      throw new Error("remote discovery should not block initial render");
    });
    const registry = fakeRegistry({
      providers: [
        provider({ id: "openai", name: "OpenAI", authType: "oauth" }),
        provider({ id: "deepseek", name: "DeepSeek" }),
        provider({ id: "fireworks", name: "Fireworks" }),
      ],
      customModels: {
        fireworks: [{ id: "accounts/fireworks/models/kimi-k2p6", name: "Kimi-K2.6", providerId: "fireworks" }],
      },
      listModels,
    });

    const options = buildLocalModelOptions(registry, "openai:gpt-5.4", ["deepseek:deepseek-v4-pro"]);

    expect(listModels).not.toHaveBeenCalled();
    expect(options.map((option) => option.id)).toContain("deepseek:deepseek-v4-pro");
    expect(options.map((option) => option.id)).toContain("openai:gpt-5.4");
    expect(options.map((option) => option.id)).toContain("fireworks:accounts/fireworks/models/kimi-k2p6");
  });
});

function provider(input: Partial<ProviderProfile> & Pick<ProviderProfile, "id" | "name">): ProviderProfile {
  return {
    baseURL: "https://example.com",
    apiKey: "sk-test",
    enabled: true,
    ...input,
  };
}

function fakeRegistry(input: {
  providers: ProviderProfile[];
  customModels?: Record<string, Array<{ id: string; name?: string; providerId: string }>>;
  listModels?: ProviderRegistry["listModels"];
}): ProviderRegistry {
  return {
    getEnabled: () => input.providers,
    getModelConfig: () => ({
      getCustomModels: (providerId: string) => input.customModels?.[providerId] ?? [],
    }),
    listModels: input.listModels,
  } as unknown as ProviderRegistry;
}

import { listBuiltinModels } from "../model-catalog.js";
import {
  isUserVisibleProvider,
  type ModelInfo,
  type ProviderProfile,
  type ProviderRegistry,
} from "../provider-registry.js";

export type ModelPickerRegistry = Pick<ProviderRegistry, "getEnabled" | "getModelConfig" | "listModels">;

export type ModelProviderGroup = {
  provider: ProviderProfile;
  models: ModelInfo[];
};

export function localModelsForProvider(
  registry: Pick<ProviderRegistry, "getModelConfig">,
  provider: ProviderProfile,
): ModelInfo[] {
  const customModels = registry.getModelConfig().getCustomModels(provider.id);
  if (customModels.length > 0) return customModels;

  const builtinProviderId = provider.id === "openai" && provider.authType === "oauth"
    ? "openai-codex"
    : provider.id;

  return listBuiltinModels(builtinProviderId).map((model) => ({
    id: model.id,
    name: model.name,
    providerId: provider.id,
    reasoningLevels: model.reasoningLevels,
    defaultReasoningLevel: model.defaultReasoningLevel,
    contextWindow: model.contextWindow,
    useResponsesLite: model.useResponsesLite,
    toolOutputTokenLimit: model.toolOutputTokenLimit,
    tier: model.tier,
  }));
}

export function getVisibleModelProviders(
  registry: Pick<ProviderRegistry, "getEnabled">,
  providerId?: string,
): ProviderProfile[] {
  return registry
    .getEnabled()
    .filter((provider) => isUserVisibleProvider(provider.id))
    .filter((provider) => !providerId || provider.id === providerId);
}

export async function discoverModelProviderGroups(
  registry: ModelPickerRegistry,
  providerId?: string,
): Promise<ModelProviderGroup[]> {
  const providers = getVisibleModelProviders(registry, providerId);

  return Promise.all(providers.map(async (provider) => {
    try {
      return { provider, models: await registry.listModels(provider) };
    } catch {
      return { provider, models: localModelsForProvider(registry, provider) };
    }
  }));
}

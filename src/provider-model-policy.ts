/**
 * Stable provider-level model constraints.
 *
 * Catalog discovery describes what a provider currently lists; it is not a
 * runtime security boundary. A fixed policy is different: Bubble deliberately
 * exposes and permits exactly one model for that provider, across every host
 * and caller (TUI, CLI, SDK, Feishu, parent agents, and subagents).
 */

export const OPENROUTER_MODEL_ID = "stealth/ox-alpha";

const FIXED_PROVIDER_MODELS: Readonly<Record<string, string>> = {
  openrouter: OPENROUTER_MODEL_ID,
};

export function getFixedProviderModelId(providerId: string): string | undefined {
  return FIXED_PROVIDER_MODELS[providerId.toLowerCase()];
}

export function isProviderModelAllowed(providerId: string, modelId: string): boolean {
  const fixedModelId = getFixedProviderModelId(providerId);
  return !fixedModelId || modelId === fixedModelId;
}

export function providerModelPolicyError(providerId: string, modelId: string): string | undefined {
  const fixedModelId = getFixedProviderModelId(providerId);
  if (!fixedModelId || modelId === fixedModelId) return undefined;
  return `Provider "${providerId}" is fixed to model "${fixedModelId}"; received "${modelId}".`;
}

export function assertProviderModelAllowed(providerId: string, modelId: string): void {
  const error = providerModelPolicyError(providerId, modelId);
  if (error) throw new Error(error);
}

export function filterProviderModels<T extends { id: string }>(providerId: string, models: readonly T[]): T[] {
  return models.filter((model) => isProviderModelAllowed(providerId, model.id));
}

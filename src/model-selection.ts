import { decodeModel, encodeModel } from "./provider-registry.js";
import { assertProviderModelAllowed } from "./provider-model-policy.js";

export interface ResolveConfiguredModelInput {
  cliModel?: string;
  sessionModel?: string;
  defaultModel?: string;
  fallbackProviderId?: string;
}

export function resolveConfiguredModel(input: ResolveConfiguredModelInput): string {
  const selected = input.cliModel ?? input.sessionModel ?? input.defaultModel;
  if (!selected) return "";
  const normalized = selected.includes(":")
    ? selected
    : input.fallbackProviderId
      ? encodeModel(input.fallbackProviderId, selected)
      : "";
  if (!normalized) return "";
  const { providerId, modelId } = decodeModel(normalized);
  if (providerId) assertProviderModelAllowed(providerId, modelId);
  return normalized;
}

import { encodeModel } from "./provider-registry.js";

export interface ResolveConfiguredModelInput {
  cliModel?: string;
  sessionModel?: string;
  defaultModel?: string;
  fallbackProviderId?: string;
}

export function resolveConfiguredModel(input: ResolveConfiguredModelInput): string {
  const selected = input.cliModel ?? input.sessionModel ?? input.defaultModel;
  if (!selected) return "";
  if (selected.includes(":")) return selected;
  return input.fallbackProviderId ? encodeModel(input.fallbackProviderId, selected) : "";
}

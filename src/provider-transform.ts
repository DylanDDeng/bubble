import type { ThinkingLevel } from "./types.js";
import { getAvailableThinkingLevels, normalizeThinkingLevel } from "./variant/variant-resolver.js";
export { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "./variant/variant-resolver.js";

export interface ProviderRequestConfig {
  effectiveThinkingLevel: ThinkingLevel;
  reasoningEffort?: ThinkingLevel;
}

export function resolveProviderRequestConfig(
  providerId: string,
  modelId: string,
  requestedLevel: ThinkingLevel,
): ProviderRequestConfig {
  const supportedLevels = getAvailableThinkingLevels(providerId, modelId);
  const effectiveThinkingLevel = normalizeThinkingLevel(requestedLevel, supportedLevels);

  // ChatGPT OAuth via openai-codex currently rejects explicit reasoning params for this account path.
  // Keep the session/UI state, but don't send reasoning flags on this provider until the protocol is clearer.
  if (providerId === "openai-codex") {
    return { effectiveThinkingLevel };
  }

  if (
    providerId === "openai"
    || providerId === "openrouter"
    || providerId === "google"
    || providerId === "azure"
    || providerId === "openai-compatible"
  ) {
    return {
      effectiveThinkingLevel,
      reasoningEffort: effectiveThinkingLevel === "off" ? undefined : effectiveThinkingLevel,
    };
  }

  return { effectiveThinkingLevel };
}

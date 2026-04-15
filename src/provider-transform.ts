import { getBuiltinModel } from "./model-catalog.js";
import type { ReasoningEffort } from "./types.js";

export interface ProviderRequestConfig {
  effectiveThinkingLevel: ReasoningEffort;
  reasoningEffort?: ReasoningEffort;
}

export function getAvailableThinkingLevels(providerId: string, modelId: string): ReasoningEffort[] {
  return getBuiltinModel(providerId, modelId)?.reasoningLevels ?? ["off"];
}

export function getDefaultThinkingLevel(providerId: string, modelId: string): ReasoningEffort {
  const levels = getAvailableThinkingLevels(providerId, modelId);
  return levels.includes("medium") ? "medium" : levels[0] || "off";
}

export function resolveProviderRequestConfig(
  providerId: string,
  modelId: string,
  requestedLevel: ReasoningEffort,
): ProviderRequestConfig {
  const supportedLevels = getAvailableThinkingLevels(providerId, modelId);
  const effectiveThinkingLevel = normalizeThinkingLevel(requestedLevel, supportedLevels);

  // ChatGPT OAuth via openai-codex currently rejects explicit reasoning params for this account path.
  // Keep the session/UI state, but don't send reasoning flags on this provider until the protocol is clearer.
  if (providerId === "openai-codex") {
    return { effectiveThinkingLevel };
  }

  if (providerId === "openai" || providerId === "google" || providerId === "azure" || providerId === "openai-compatible") {
    return {
      effectiveThinkingLevel,
      reasoningEffort: effectiveThinkingLevel === "off" ? undefined : effectiveThinkingLevel,
    };
  }

  return { effectiveThinkingLevel };
}

export function normalizeThinkingLevel(level: ReasoningEffort, supportedLevels: readonly ReasoningEffort[]): ReasoningEffort {
  if (supportedLevels.length === 0) {
    return "off";
  }
  if (supportedLevels.includes(level)) {
    return level;
  }

  const order: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const requestedIndex = order.indexOf(level);
  for (let i = requestedIndex; i >= 0; i--) {
    const candidate = order[i];
    if (supportedLevels.includes(candidate)) {
      return candidate;
    }
  }

  return supportedLevels[0];
}

import type { ThinkingLevel } from "./types.js";
import { getAvailableThinkingLevels, normalizeThinkingLevel } from "./variant/variant-resolver.js";
export { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "./variant/variant-resolver.js";

export interface ProviderRequestConfig {
  effectiveThinkingLevel: ThinkingLevel;
  reasoningEffort?: ThinkingLevel;
  extraBody?: Record<string, unknown>;
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

  // Zhipu/Z.AI OpenAI-compatible endpoints expose reasoning via a provider-specific
  // `thinking` block rather than OpenAI's `reasoning_effort` shape.
  if (
    ["zhipuai", "zhipuai-coding-plan", "zai", "zai-coding-plan"].includes(providerId)
  ) {
    return {
      effectiveThinkingLevel,
      extraBody: effectiveThinkingLevel === "off"
        ? undefined
        : {
            thinking: {
              type: "enabled",
              clear_thinking: false,
            },
          },
    };
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

import type { ThinkingLevel } from "./types.js";
import { getAvailableThinkingLevels, normalizeThinkingLevel } from "./variant/variant-resolver.js";
export { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "./variant/variant-resolver.js";

export interface ProviderRequestConfig {
  effectiveThinkingLevel: ThinkingLevel;
  reasoningEffort?: ThinkingLevel;
  reasoningContentEcho?: "tool_calls" | "all";
  extraBody?: Record<string, unknown>;
  omitTemperature?: boolean;
}

const MOONSHOT_PROVIDER_IDS = new Set(["moonshot-cn", "moonshot-intl", "kimi-for-coding"]);
const KIMI_K25_FAMILY = new Set(["kimi-k2.5", "k2.6-code-preview", "kimi-k2.6"]);
const KIMI_THINKING_FAMILY = new Set(["kimi-k2-thinking", "kimi-k2-thinking-turbo"]);

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

  if (providerId === "deepseek" && modelId === "deepseek-v4-pro") {
    return {
      effectiveThinkingLevel,
      reasoningContentEcho: "all",
      extraBody: {
        thinking: { type: "enabled" },
        reasoning_effort: effectiveThinkingLevel,
      },
    };
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

  // Moonshot / Kimi: kimi-k2.5 family (incl. k2.6-code-preview, kimi-k2.6) locks
  // temperature/top_p/n/penalties and exposes thinking via extra_body.thinking;
  // kimi-k2-thinking family locks temperature=1.
  if (MOONSHOT_PROVIDER_IDS.has(providerId)) {
    if (KIMI_K25_FAMILY.has(modelId)) {
      return {
        effectiveThinkingLevel,
        omitTemperature: true,
        reasoningContentEcho: "tool_calls",
        extraBody: {
          thinking: { type: effectiveThinkingLevel === "off" ? "disabled" : "enabled" },
        },
      };
    }
    if (KIMI_THINKING_FAMILY.has(modelId)) {
      return { effectiveThinkingLevel, omitTemperature: true };
    }
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

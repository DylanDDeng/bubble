import type { ThinkingLevel } from "./types.js";
import { getBuiltinModel } from "./model-catalog.js";
import { getAvailableThinkingLevels, normalizeInheritedThinkingLevel, normalizeThinkingLevel } from "./variant/variant-resolver.js";
export { getAvailableThinkingLevels, getDefaultThinkingLevel, isThinkingOnlyLevels, isThinkingOnlyModel, isThinkingToggleModel, normalizeInheritedThinkingLevel, normalizeThinkingLevel } from "./variant/variant-resolver.js";

export interface ProviderRequestConfig {
  effectiveThinkingLevel: ThinkingLevel;
  reasoningEffort?: ThinkingLevel;
  reasoningContentEcho?: "tool_calls" | "all" | "none" | "minimax";
  parallelToolCalls?: boolean;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  omitTemperature?: boolean;
}

const MOONSHOT_PROVIDER_IDS = new Set(["moonshot-cn", "moonshot-intl", "kimi-for-coding"]);
const KIMI_K27_FAMILY = new Set([
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  // Coding-plan slot ids for the same generation (GET /coding/v1/models).
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
]);
// K3 takes OpenAI-style reasoning_effort (low/high/max, no "medium"); "off"
// disables thinking via top-level thinking.type. Verified live: effort changes
// reasoning-token spend, and nested extra_body.thinking is ignored server-side.
const KIMI_K3_FAMILY = new Set(["k3", "k3-256k", "kimi-k3"]);
const KIMI_TOGGLE_THINKING_FAMILY = new Set(["kimi-k2.5", "kimi-k2.6"]);
const KIMI_K26_DEFAULT_MAX_TOKENS = 32768;
const MINIMAX_M3_FAMILY = new Set(["MiniMax-M3"]);
const DEEPSEEK_V4_FAMILY = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
]);

function isFireworksKimi(providerId: string, modelId: string): boolean {
  const model = modelId.toLowerCase();
  return providerId === "fireworks" && (
    model.includes("kimi")
    || model.includes("k2p6")
    || model === "k2.6"
  );
}

export function resolveProviderRequestConfig(
  providerId: string,
  modelId: string,
  requestedLevel: ThinkingLevel,
): ProviderRequestConfig {
  const supportedLevels = getAvailableThinkingLevels(providerId, modelId);
  const effectiveThinkingLevel = normalizeThinkingLevel(requestedLevel, supportedLevels);

  if (providerId === "openai-codex") {
    const model = getBuiltinModel(providerId, modelId);
    if (!model || model.reasoningLevels.length === 0) {
      return { effectiveThinkingLevel: "off" };
    }

    // Provider serialization is the final defensive boundary. Upstream model
    // selection validates explicit choices, while inherited stale state falls
    // back to the model's declared default here rather than leaking an invalid
    // effort to the ChatGPT Responses endpoint.
    const codexThinkingLevel = normalizeInheritedThinkingLevel(providerId, modelId, requestedLevel);
    return {
      effectiveThinkingLevel: codexThinkingLevel,
      reasoningEffort: codexThinkingLevel !== "off" && model.reasoningLevels.includes(codexThinkingLevel)
        ? codexThinkingLevel
        : undefined,
    };
  }

  // Grok's CLI chat proxy is OpenAI-compatible; effort rides in the body as
  // `reasoning_effort`, and reasoning arrives back as `reasoning_content`.
  if (providerId === "grok") {
    return {
      effectiveThinkingLevel,
      extraBody: effectiveThinkingLevel === "off"
        ? undefined
        : { reasoning_effort: effectiveThinkingLevel },
    };
  }

  // Ox Alpha exposes mandatory low/high/max reasoning. Treat unsupported state
  // restored from an older session as inherited state and fall back to the
  // model's declared default (max), never OpenRouter's disabling "none" value.
  if (providerId === "openrouter") {
    const openRouterThinkingLevel = normalizeInheritedThinkingLevel(
      providerId,
      modelId,
      requestedLevel,
    );
    return {
      effectiveThinkingLevel: openRouterThinkingLevel,
      reasoningContentEcho: "tool_calls",
      extraBody: {
        reasoning: {
          effort: openRouterThinkingLevel,
        },
      },
    };
  }

  if (isFireworksKimi(providerId, modelId)) {
    return {
      effectiveThinkingLevel,
      reasoningContentEcho: "none",
      parallelToolCalls: false,
      maxTokens: KIMI_K26_DEFAULT_MAX_TOKENS,
    };
  }

  if (providerId === "deepseek" && DEEPSEEK_V4_FAMILY.has(modelId)) {
    if (effectiveThinkingLevel === "off") {
      return {
        effectiveThinkingLevel,
        // Non-thinking requests do not need prior reasoning replayed. Omitting
        // reasoning_content also keeps the history valid when switching modes.
        reasoningContentEcho: "none",
        extraBody: { thinking: { type: "disabled" } },
      };
    }
    return {
      effectiveThinkingLevel,
      reasoningContentEcho: "all",
      extraBody: {
        thinking: { type: "enabled" },
        reasoning_effort: effectiveThinkingLevel,
      },
    };
  }

  // Bailian token plan speaks OpenAI-compatible reasoning_effort, with "none"
  // as its off value (verified: enable_thinking=false works too, but "none"
  // keeps one parameter for every level). Grades are validated server-side —
  // an unknown value is a 400 — so the catalog's per-model ladder matters.
  if (providerId === "bailian-token-plan") {
    return {
      effectiveThinkingLevel,
      extraBody: {
        reasoning_effort: effectiveThinkingLevel === "off" ? "none" : effectiveThinkingLevel,
      },
    };
  }

  if (providerId === "stepfun") {
    return {
      effectiveThinkingLevel,
      reasoningContentEcho: "none",
      extraBody: effectiveThinkingLevel === "off"
        ? undefined
        : { reasoning_effort: effectiveThinkingLevel },
    };
  }

  if (providerId === "doubao") {
    return {
      effectiveThinkingLevel,
      parallelToolCalls: false,
      extraBody: { reasoning_effort: effectiveThinkingLevel },
    };
  }

  if (providerId === "minimax" || providerId === "minimax-openai") {
    const extraBody: Record<string, unknown> = { reasoning_split: true };
    if (MINIMAX_M3_FAMILY.has(modelId)) {
      extraBody.thinking = {
        type: effectiveThinkingLevel === "off" ? "disabled" : "adaptive",
      };
    }
    return {
      effectiveThinkingLevel,
      reasoningContentEcho: "minimax",
      extraBody,
    };
  }

  // Zhipu/Z.AI OpenAI-compatible endpoints expose reasoning via a provider-specific
  // `thinking` block rather than OpenAI's `reasoning_effort` shape.
  if (
    ["zhipuai", "zhipuai-coding-plan", "zai", "zai-coding-plan"].includes(providerId)
  ) {
    // GLM-5.2+ also accept `reasoning_effort`. GLM-5.2 can disable thinking;
    // the GLM-5.3 family requires thinking and normalizes its effort into
    // low/high/max. The catalog clamps 5.3 choices before this serialization
    // boundary. The effort field rides inside the body alongside `thinking`,
    // so it goes in extraBody, not the OpenRouter-style config field.
    if (modelId === "glm-5.2" || modelId === "glm-5.3" || modelId === "glm-5.3-flash") {
      return {
        effectiveThinkingLevel,
        extraBody: modelId === "glm-5.2" && effectiveThinkingLevel === "off"
          ? { thinking: { type: "disabled" } }
          : {
              thinking: { type: "enabled", clear_thinking: false },
              reasoning_effort: effectiveThinkingLevel,
            },
      };
    }
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

  // Moonshot / Kimi: K2.5/K2.6 lock temperature/top_p/n/penalties and expose
  // thinking via extra_body.thinking.
  if (MOONSHOT_PROVIDER_IDS.has(providerId)) {
    // Kimi K2.7 Code variants are thinking-only: temperature is locked to 1.0
    // server-side (any explicit value errors), thinking can never be disabled, and
    // reasoning_content must be echoed back on tool-call turns.
    if (KIMI_K27_FAMILY.has(modelId)) {
      return {
        effectiveThinkingLevel,
        omitTemperature: true,
        reasoningContentEcho: "tool_calls",
        extraBody: {
          thinking: { type: "enabled" },
        },
      };
    }
    if (KIMI_K3_FAMILY.has(modelId)) {
      return {
        effectiveThinkingLevel,
        omitTemperature: true,
        reasoningContentEcho: "tool_calls",
        // extraBody spreads onto the request body verbatim. The sibling
        // `reasoningEffort` field is NOT the same thing: the generic chat path
        // turns it into OpenRouter's `reasoning: {enabled: true}`, which drops
        // the grade entirely.
        extraBody: effectiveThinkingLevel === "off"
          ? { thinking: { type: "disabled" } }
          : { reasoning_effort: effectiveThinkingLevel },
      };
    }
    if (KIMI_TOGGLE_THINKING_FAMILY.has(modelId)) {
      return {
        effectiveThinkingLevel,
        omitTemperature: true,
        reasoningContentEcho: "tool_calls",
        extraBody: {
          thinking: { type: effectiveThinkingLevel === "off" ? "disabled" : "enabled" },
        },
      };
    }
    return { effectiveThinkingLevel };
  }

  if (
    providerId === "openai"
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

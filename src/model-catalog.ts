import type { ReasoningEffort } from "./types.js";

export type ProviderProtocol = "openai-chat" | "anthropic-messages" | "ark-responses" | "ai-sdk";

export interface BuiltinProviderDefinition {
  id: string;
  name: string;
  baseURL: string;
  protocol?: ProviderProtocol;
  hidden?: boolean;
  supportsOAuth?: boolean;
}

export interface BuiltinModelDefinition {
  id: string;
  name: string;
  providerId: string;
  reasoningLevels: ReasoningEffort[];
  defaultReasoningLevel?: ReasoningEffort;
  contextWindow?: number;
  /** Routes this model through the Codex Responses Lite backend when true. */
  useResponsesLite?: boolean;
  /**
   * Server-declared cap on per-tool-output tokens. When set, the agent must
   * truncate each tool result to this token budget before adding it to history
   * — otherwise the server's input window is exceeded by raw tool dumps.
   * (For codex models this comes from the API's `truncation_policy.limit`.)
   */
  toolOutputTokenLimit?: number;
}

export const BUILTIN_PROVIDERS: BuiltinProviderDefinition[] = [
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", supportsOAuth: true },
  { id: "openai-codex", name: "OpenAI Codex (ChatGPT)", baseURL: "https://chatgpt.com/backend-api" },
  // Grok subscription models via the CLI chat proxy. OAuth-only: the proxy
  // accepts xAI session bearers (from /login grok), not api.x.ai API keys.
  { id: "grok", name: "Grok Subscription", baseURL: "https://cli-chat-proxy.grok.com/v1", supportsOAuth: true },
  { id: "anthropic", name: "Anthropic", baseURL: "https://api.anthropic.com", protocol: "anthropic-messages" },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com" },
  // Native Gemini API via the AI SDK google provider. Users who configured the
  // old OpenAI-compat endpoint can keep it by setting protocol "openai-chat"
  // and the /openai baseURL explicitly in models.json.
  { id: "google", name: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta", protocol: "ai-sdk" },
  { id: "zhipuai", name: "Zhipu AI", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "zhipuai-coding-plan", name: "Zhipu AI Coding Plan", baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" },
  { id: "zai", name: "Z.AI", baseURL: "https://api.z.ai/api/paas/v4" },
  { id: "zai-coding-plan", name: "Z.AI Coding Plan", baseURL: "https://api.z.ai/api/coding/paas/v4" },
  { id: "alibaba", name: "Alibaba DashScope", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "doubao", name: "Doubao (Volcengine Ark)", baseURL: "https://ark.cn-beijing.volces.com/api/v3", protocol: "ark-responses" },
  { id: "minimax", name: "MiniMax Token Plan", baseURL: "https://api.minimaxi.com/anthropic", protocol: "anthropic-messages" },
  { id: "minimax-anthropic", name: "MiniMax API", baseURL: "https://api.minimaxi.com/anthropic", protocol: "anthropic-messages" },
  { id: "stepfun", name: "StepFun Step Plan", baseURL: "https://api.stepfun.com/step_plan/v1" },
  { id: "moonshot-cn", name: "Moonshot (国内 platform.moonshot.cn)", baseURL: "https://api.moonshot.cn/v1" },
  { id: "moonshot-intl", name: "Moonshot (海外 platform.moonshot.ai)", baseURL: "https://api.moonshot.ai/v1" },
  { id: "kimi-for-coding", name: "Kimi for Coding", baseURL: "https://api.kimi.com/coding/v1" },
  { id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  { id: "together", name: "Together AI", baseURL: "https://api.together.xyz/v1" },
  { id: "fireworks", name: "Fireworks", baseURL: "https://api.fireworks.ai/inference/v1" },
  { id: "local", name: "Local (OpenAI-compatible)", baseURL: "http://localhost:11434/v1" },
];

const ALL_OPENAI_LEVELS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const GPT56_LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const GPT56_LUNA_LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const GPT51_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high"];
const GPT51_CODEX_MAX_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh"];
const GPT51_CODEX_MINI_LEVELS: ReasoningEffort[] = ["off", "medium", "high"];
const OPENAI_CHAT_LEVELS: ReasoningEffort[] = ["off"];
// Internal representation for APIs that expose thinking as enabled/disabled.
// UI code must render supported toggle models as on/off, not as "medium" effort.
const TOGGLE_THINKING_LEVELS: ReasoningEffort[] = ["off", "medium"];
// GLM-5.2 is the first GLM to accept OpenAI-style `reasoning_effort`. The API
// enum is none/minimal/low/medium/high/xhigh/max; we expose high and max (the
// two effort tiers worth offering a coding agent) plus "off", which disables
// thinking outright via `thinking: {type: "disabled"}`. Order matters: "high"
// is first so it is the default (getDefaultThinkingLevel falls back to levels[0]
// when "medium" is absent), since GLM-5.2 is a thinking-on-by-default model.
const GLM_5_2_LEVELS: ReasoningEffort[] = ["high", "max", "off"];
// Kimi K2.7 Code variants only support thinking mode (disabling it errors), so
// "off" is not offered — the model is always in its thinking variant.
const KIMI_THINKING_ONLY_LEVELS: ReasoningEffort[] = ["medium"];
const DEEPSEEK_V4_LEVELS: ReasoningEffort[] = ["high", "max"];
const STEPFUN_REASONING_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high"];
const DOUBAO_SEED_REASONING_LEVELS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const MINIMAX_M3_REASONING_LEVELS: ReasoningEffort[] = ["off", "medium"];
const MINIMAX_REASONING_LEVELS: ReasoningEffort[] = ["medium"];
// Anthropic exposes reasoning depth through output_config.effort (low | medium
// | high | xhigh | max), not a token budget. xhigh is Opus 4.7+ only; max is
// Opus 4.6+/Sonnet 4.6/Fable 5; Haiku 4.5 does not accept the effort param.
// Fable 5 has thinking always on, so it has no "off". "off" disables thinking.
const ANTHROPIC_OPUS_EFFORT_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh", "max"];
const ANTHROPIC_SONNET_EFFORT_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high", "max"];
const ANTHROPIC_FABLE_EFFORT_LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const ANTHROPIC_CHAT_LEVELS: ReasoningEffort[] = ["off"];
// Grok 4.5 exposes low/medium/high effort with no "off" (thinking always on);
// the composer model declares no effort support at all.
const GROK_45_LEVELS: ReasoningEffort[] = ["low", "medium", "high"];
const GEMINI_3_LEVELS: ReasoningEffort[] = ["low", "medium", "high"];
const GEMINI_3_FLASH_LEVELS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const GEMINI_25_PRO_LEVELS: ReasoningEffort[] = ["low", "medium", "high"];
const GEMINI_25_FLASH_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high"];

export const BUILTIN_MODELS: BuiltinModelDefinition[] = [
  { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", providerId: "openai-codex", reasoningLevels: GPT56_LEVELS, defaultReasoningLevel: "low", contextWindow: 372000, useResponsesLite: true, toolOutputTokenLimit: 10000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", providerId: "openai-codex", reasoningLevels: GPT56_LEVELS, defaultReasoningLevel: "medium", contextWindow: 372000, useResponsesLite: true, toolOutputTokenLimit: 10000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", providerId: "openai-codex", reasoningLevels: GPT56_LUNA_LEVELS, defaultReasoningLevel: "medium", contextWindow: 372000, useResponsesLite: true, toolOutputTokenLimit: 10000 },
  { id: "gpt-5.5", name: "gpt-5.5", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS, contextWindow: 272000, toolOutputTokenLimit: 10000 },
  { id: "gpt-5.4", name: "gpt-5.4", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.4-mini", name: "gpt-5.4-mini", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.3-codex", name: "gpt-5.3-codex", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.3-codex-spark", name: "gpt-5.3-codex-spark", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.2-codex", name: "gpt-5.2-codex", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.2", name: "gpt-5.2", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.1-codex-max", name: "gpt-5.1-codex-max", providerId: "openai-codex", reasoningLevels: GPT51_CODEX_MAX_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.1-codex-mini", name: "gpt-5.1-codex-mini", providerId: "openai-codex", reasoningLevels: GPT51_CODEX_MINI_LEVELS, contextWindow: 272000 },
  { id: "gpt-5.1", name: "gpt-5.1", providerId: "openai-codex", reasoningLevels: GPT51_LEVELS, contextWindow: 272000 },

  { id: "grok-4.5", name: "Grok 4.5", providerId: "grok", reasoningLevels: GROK_45_LEVELS, defaultReasoningLevel: "high", contextWindow: 500000 },
  { id: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast", providerId: "grok", reasoningLevels: OPENAI_CHAT_LEVELS, contextWindow: 200000 },

  { id: "gpt-4o", name: "gpt-4o", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS, contextWindow: 128000 },
  { id: "gpt-4o-mini", name: "gpt-4o-mini", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS, contextWindow: 128000 },
  { id: "o1-preview", name: "o1-preview", providerId: "openai", reasoningLevels: ["off", "low", "medium", "high"], contextWindow: 128000 },
  { id: "o1-mini", name: "o1-mini", providerId: "openai", reasoningLevels: ["off", "low", "medium", "high"], contextWindow: 128000 },
  { id: "gpt-4-turbo", name: "gpt-4-turbo", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS, contextWindow: 128000 },

  { id: "claude-fable-5", name: "Claude Fable 5", providerId: "anthropic", reasoningLevels: ANTHROPIC_FABLE_EFFORT_LEVELS, defaultReasoningLevel: "high", contextWindow: 1000000 },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", providerId: "anthropic", reasoningLevels: ANTHROPIC_OPUS_EFFORT_LEVELS, defaultReasoningLevel: "high", contextWindow: 1000000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", providerId: "anthropic", reasoningLevels: ANTHROPIC_SONNET_EFFORT_LEVELS, defaultReasoningLevel: "high", contextWindow: 1000000 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", providerId: "anthropic", reasoningLevels: ANTHROPIC_CHAT_LEVELS, contextWindow: 200000 },

  { id: "deepseek-v4-flash", name: "deepseek-v4-flash", providerId: "deepseek", reasoningLevels: DEEPSEEK_V4_LEVELS, contextWindow: 1048576 },
  { id: "deepseek-v4-pro", name: "deepseek-v4-pro", providerId: "deepseek", reasoningLevels: DEEPSEEK_V4_LEVELS, contextWindow: 1048576 },
  // Offline/no-key fallback only: with an API key the registry replaces this
  // list via fetchGeminiModels (GET /v1beta/models, newest five). Gemini 3
  // exposes thinking_level (minimal/low/medium/high); 2.5 Pro cannot disable
  // thinking (no "off"), 2.5 Flash can (thinkingBudget 0).
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", providerId: "google", reasoningLevels: GEMINI_3_FLASH_LEVELS, contextWindow: 1048576 },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", providerId: "google", reasoningLevels: GEMINI_3_LEVELS, defaultReasoningLevel: "high", contextWindow: 1048576 },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", providerId: "google", reasoningLevels: GEMINI_3_FLASH_LEVELS, contextWindow: 1048576 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", providerId: "google", reasoningLevels: GEMINI_25_PRO_LEVELS, defaultReasoningLevel: "high", contextWindow: 1048576 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", providerId: "google", reasoningLevels: GEMINI_25_FLASH_LEVELS, contextWindow: 1048576 },
  { id: "glm-5.2", name: "GLM-5.2", providerId: "zhipuai", reasoningLevels: GLM_5_2_LEVELS, contextWindow: 1000000 },
  { id: "glm-5.1", name: "GLM-5.1", providerId: "zhipuai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zhipuai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zhipuai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-5.2", name: "GLM-5.2", providerId: "zhipuai-coding-plan", reasoningLevels: GLM_5_2_LEVELS, contextWindow: 1000000 },
  { id: "glm-5.1", name: "GLM-5.1", providerId: "zhipuai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zhipuai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zhipuai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-5.2", name: "GLM-5.2", providerId: "zai", reasoningLevels: GLM_5_2_LEVELS, contextWindow: 1000000 },
  { id: "glm-5.1", name: "GLM-5.1", providerId: "zai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-5.2", name: "GLM-5.2", providerId: "zai-coding-plan", reasoningLevels: GLM_5_2_LEVELS, contextWindow: 1000000 },
  { id: "glm-5-turbo", name: "GLM-5-Turbo", providerId: "zai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", providerId: "alibaba", reasoningLevels: ["off"], contextWindow: 1048576 },
  { id: "qwen3.7-max", name: "Qwen3.7 Max", providerId: "alibaba", reasoningLevels: ["off"], contextWindow: 1048576 },
  { id: "doubao-seed-2-1-pro-260628", name: "Doubao Seed 2.1 Pro", providerId: "doubao", reasoningLevels: DOUBAO_SEED_REASONING_LEVELS, defaultReasoningLevel: "high" },
  { id: "MiniMax-M3", name: "MiniMax M3", providerId: "minimax", reasoningLevels: MINIMAX_M3_REASONING_LEVELS, contextWindow: 1000000 },
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M3", name: "MiniMax M3", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_M3_REASONING_LEVELS, contextWindow: 1000000 },
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "step-3.7-flash", name: "Step 3.7 Flash", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS, contextWindow: 256000 },
  { id: "step-3.5-flash-2603", name: "Step 3.5 Flash 2603", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS },
  { id: "step-3.5-flash", name: "Step 3.5 Flash", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS },
  { id: "step-router-v1", name: "Step Router V1", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", providerId: "moonshot-cn", reasoningLevels: KIMI_THINKING_ONLY_LEVELS, contextWindow: 262144 },
  { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed", providerId: "moonshot-cn", reasoningLevels: KIMI_THINKING_ONLY_LEVELS, contextWindow: 262144 },
  { id: "kimi-k2.6", name: "Kimi K2.6", providerId: "moonshot-cn", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.5", name: "Kimi K2.5", providerId: "moonshot-cn", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", providerId: "moonshot-intl", reasoningLevels: KIMI_THINKING_ONLY_LEVELS, contextWindow: 262144 },
  { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed", providerId: "moonshot-intl", reasoningLevels: KIMI_THINKING_ONLY_LEVELS, contextWindow: 262144 },
  { id: "kimi-k2.6", name: "Kimi K2.6", providerId: "moonshot-intl", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.5", name: "Kimi K2.5", providerId: "moonshot-intl", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", providerId: "kimi-for-coding", reasoningLevels: KIMI_THINKING_ONLY_LEVELS, contextWindow: 262144 },
  { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed", providerId: "kimi-for-coding", reasoningLevels: KIMI_THINKING_ONLY_LEVELS, contextWindow: 262144 },
  { id: "kimi-k2.6", name: "Kimi K2.6", providerId: "kimi-for-coding", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.5", name: "Kimi K2.5", providerId: "kimi-for-coding", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b-versatile", providerId: "groq", reasoningLevels: ["off"], contextWindow: 32768 },
  { id: "mixtral-8x7b-32768", name: "mixtral-8x7b-32768", providerId: "groq", reasoningLevels: ["off"], contextWindow: 32768 },
  { id: "gemma-2-9b-it", name: "gemma-2-9b-it", providerId: "groq", reasoningLevels: ["off"], contextWindow: 32768 },
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "meta-llama/Llama-3.3-70B-Instruct-Turbo", providerId: "together", reasoningLevels: ["off"], contextWindow: 32768 },
  { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen/Qwen2.5-72B-Instruct", providerId: "together", reasoningLevels: ["off"], contextWindow: 32768 },
  { id: "accounts/fireworks/models/kimi-k2p6", name: "Kimi-K2.6", providerId: "fireworks", reasoningLevels: ["off"], contextWindow: 256000 },
  { id: "llama3.1", name: "llama3.1", providerId: "local", reasoningLevels: ["off"], contextWindow: 32768 },
  { id: "qwen2.5", name: "qwen2.5", providerId: "local", reasoningLevels: ["off"], contextWindow: 32768 },
  { id: "deepseek-coder-v2", name: "deepseek-coder-v2", providerId: "local", reasoningLevels: ["off"], contextWindow: 32768 },
];

export function listBuiltinModels(providerId: string): BuiltinModelDefinition[] {
  return BUILTIN_MODELS.filter((model) => model.providerId === providerId);
}

// Runtime overlay populated from provider-side discovery (e.g. ChatGPT codex /models).
// Looked up before the static catalog so newly-released models work without a code change.
const dynamicOverlay = new Map<string, BuiltinModelDefinition>();

function overlayKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function registerDynamicModelMetadata(model: BuiltinModelDefinition): void {
  dynamicOverlay.set(overlayKey(model.providerId, model.id), model);
}

export function clearDynamicModelMetadata(providerId: string): void {
  const providerIds = providerId === "openai"
    ? ["openai", "openai-codex"]
    : [providerId];
  for (const key of dynamicOverlay.keys()) {
    if (providerIds.some((id) => key.startsWith(`${id}:`))) dynamicOverlay.delete(key);
  }
}

export function replaceDynamicModelMetadata(
  providerId: string,
  models: readonly BuiltinModelDefinition[],
): void {
  clearDynamicModelMetadata(providerId);
  const acceptedProviderIds = providerId === "openai"
    ? new Set(["openai", "openai-codex"])
    : new Set([providerId]);
  for (const model of models) {
    if (acceptedProviderIds.has(model.providerId)) registerDynamicModelMetadata(model);
  }
}

export function getBuiltinModel(providerId: string, modelId: string): BuiltinModelDefinition | undefined {
  const overlayHit = dynamicOverlay.get(overlayKey(providerId, modelId))
    || (providerId === "openai" ? dynamicOverlay.get(overlayKey("openai-codex", modelId)) : undefined);
  if (overlayHit) return overlayHit;
  return BUILTIN_MODELS.find((model) => model.providerId === providerId && model.id === modelId)
    || (providerId === "openai"
      ? BUILTIN_MODELS.find((model) => model.providerId === "openai-codex" && model.id === modelId)
      : undefined);
}

export function getModelDefaultReasoningLevel(providerId: string, modelId: string): ReasoningEffort | undefined {
  return getBuiltinModel(providerId, modelId)?.defaultReasoningLevel;
}

export function getBuiltinProvider(providerId: string): BuiltinProviderDefinition | undefined {
  return BUILTIN_PROVIDERS.find((provider) => provider.id === providerId);
}

export function getModelContextWindow(providerId: string, modelId: string): number | undefined {
  return getBuiltinModel(providerId, modelId)?.contextWindow;
}

export function getToolOutputTokenLimit(providerId: string, modelId: string): number | undefined {
  return getBuiltinModel(providerId, modelId)?.toolOutputTokenLimit;
}

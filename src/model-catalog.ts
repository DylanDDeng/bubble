import type { ReasoningEffort } from "./types.js";

export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export interface BuiltinProviderDefinition {
  id: string;
  name: string;
  baseURL: string;
  protocol?: ProviderProtocol;
  supportsOAuth?: boolean;
}

export interface BuiltinModelDefinition {
  id: string;
  name: string;
  providerId: string;
  reasoningLevels: ReasoningEffort[];
  contextWindow?: number;
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
  { id: "anthropic", name: "Anthropic", baseURL: "https://api.anthropic.com", protocol: "anthropic-messages" },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com" },
  { id: "google", name: "Google", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "zhipuai", name: "Zhipu AI", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "zhipuai-coding-plan", name: "Zhipu AI Coding Plan", baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" },
  { id: "zai", name: "Z.AI", baseURL: "https://api.z.ai/api/paas/v4" },
  { id: "zai-coding-plan", name: "Z.AI Coding Plan", baseURL: "https://api.z.ai/api/coding/paas/v4" },
  { id: "alibaba", name: "Alibaba DashScope", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "minimax", name: "MiniMax", baseURL: "https://api.minimaxi.com/v1" },
  { id: "minimax-anthropic", name: "MiniMax (Anthropic)", baseURL: "https://api.minimaxi.com/anthropic", protocol: "anthropic-messages" },
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
const GPT51_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high"];
const GPT51_CODEX_MAX_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh"];
const GPT51_CODEX_MINI_LEVELS: ReasoningEffort[] = ["off", "medium", "high"];
const OPENAI_CHAT_LEVELS: ReasoningEffort[] = ["off"];
const TOGGLE_THINKING_LEVELS: ReasoningEffort[] = ["off", "medium"];
const DEEPSEEK_V4_LEVELS: ReasoningEffort[] = ["high", "max"];
const STEPFUN_REASONING_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high"];
const MINIMAX_M3_REASONING_LEVELS: ReasoningEffort[] = ["off", "medium"];
const MINIMAX_REASONING_LEVELS: ReasoningEffort[] = ["medium"];
const ANTHROPIC_ADAPTIVE_LEVELS: ReasoningEffort[] = ["off", "medium"];
const ANTHROPIC_CHAT_LEVELS: ReasoningEffort[] = ["off"];

export const BUILTIN_MODELS: BuiltinModelDefinition[] = [
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

  { id: "gpt-4o", name: "gpt-4o", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS, contextWindow: 128000 },
  { id: "gpt-4o-mini", name: "gpt-4o-mini", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS, contextWindow: 128000 },
  { id: "o1-preview", name: "o1-preview", providerId: "openai", reasoningLevels: ["off", "low", "medium", "high"], contextWindow: 128000 },
  { id: "o1-mini", name: "o1-mini", providerId: "openai", reasoningLevels: ["off", "low", "medium", "high"], contextWindow: 128000 },
  { id: "gpt-4-turbo", name: "gpt-4-turbo", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS, contextWindow: 128000 },

  { id: "claude-opus-4-8", name: "Claude Opus 4.8", providerId: "anthropic", reasoningLevels: ANTHROPIC_ADAPTIVE_LEVELS, contextWindow: 1000000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", providerId: "anthropic", reasoningLevels: ANTHROPIC_ADAPTIVE_LEVELS, contextWindow: 1000000 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", providerId: "anthropic", reasoningLevels: ANTHROPIC_CHAT_LEVELS, contextWindow: 200000 },

  { id: "deepseek-v4-flash", name: "deepseek-v4-flash", providerId: "deepseek", reasoningLevels: DEEPSEEK_V4_LEVELS, contextWindow: 1048576 },
  { id: "deepseek-v4-pro", name: "deepseek-v4-pro", providerId: "deepseek", reasoningLevels: DEEPSEEK_V4_LEVELS, contextWindow: 1048576 },
  { id: "gemini-2.5-pro-preview-03-25", name: "gemini-2.5-pro-preview-03-25", providerId: "google", reasoningLevels: ["off", "low", "high"], contextWindow: 128000 },
  { id: "gemini-2.0-flash-001", name: "gemini-2.0-flash-001", providerId: "google", reasoningLevels: ["off"], contextWindow: 128000 },
  { id: "gemini-1.5-pro-latest", name: "gemini-1.5-pro-latest", providerId: "google", reasoningLevels: ["off"], contextWindow: 128000 },
  { id: "glm-5.1", name: "GLM-5.1", providerId: "zhipuai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zhipuai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zhipuai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-5.1", name: "GLM-5.1", providerId: "zhipuai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zhipuai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zhipuai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-5.1", name: "GLM-5.1", providerId: "zai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zai", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-5-turbo", name: "GLM-5-Turbo", providerId: "zai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "glm-4.7", name: "GLM-4.7", providerId: "zai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 204800 },
  { id: "glm-4.6", name: "GLM-4.6", providerId: "zai-coding-plan", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 200000 },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", providerId: "alibaba", reasoningLevels: ["off"], contextWindow: 1048576 },
  { id: "qwen3.7-max", name: "Qwen3.7 Max", providerId: "alibaba", reasoningLevels: ["off"], contextWindow: 1048576 },
  { id: "MiniMax-M3", name: "MiniMax M3", providerId: "minimax", reasoningLevels: MINIMAX_M3_REASONING_LEVELS, contextWindow: 1000000 },
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 Highspeed", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.1", name: "MiniMax M2.1", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.1-highspeed", name: "MiniMax M2.1 Highspeed", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2", name: "MiniMax M2", providerId: "minimax", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "M2-her", name: "M2-her", providerId: "minimax", reasoningLevels: ["off"], contextWindow: 64000 },
  { id: "MiniMax-M3", name: "MiniMax M3", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_M3_REASONING_LEVELS, contextWindow: 1000000 },
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 Highspeed", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.1", name: "MiniMax M2.1", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2.1-highspeed", name: "MiniMax M2.1 Highspeed", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "MiniMax-M2", name: "MiniMax M2", providerId: "minimax-anthropic", reasoningLevels: MINIMAX_REASONING_LEVELS, contextWindow: 204800 },
  { id: "M2-her", name: "M2-her", providerId: "minimax-anthropic", reasoningLevels: ["off"], contextWindow: 64000 },
  { id: "step-3.7-flash", name: "Step 3.7 Flash", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS, contextWindow: 256000 },
  { id: "step-3.5-flash-2603", name: "Step 3.5 Flash 2603", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS },
  { id: "step-3.5-flash", name: "Step 3.5 Flash", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS },
  { id: "step-router-v1", name: "Step Router V1", providerId: "stepfun", reasoningLevels: STEPFUN_REASONING_LEVELS },
  { id: "kimi-k2.6", name: "Kimi K2.6", providerId: "moonshot-cn", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "k2.6-code-preview", name: "Kimi K2.6 Code Preview", providerId: "moonshot-cn", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.5", name: "Kimi K2.5", providerId: "moonshot-cn", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo", providerId: "moonshot-cn", reasoningLevels: ["off"], contextWindow: 256000 },
  { id: "kimi-k2-0905-preview", name: "Kimi K2 0905", providerId: "moonshot-cn", reasoningLevels: ["off"], contextWindow: 256000 },
  { id: "kimi-k2-thinking", name: "Kimi K2 Thinking", providerId: "moonshot-cn", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.6", name: "Kimi K2.6", providerId: "moonshot-intl", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "k2.6-code-preview", name: "Kimi K2.6 Code Preview", providerId: "moonshot-intl", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.5", name: "Kimi K2.5", providerId: "moonshot-intl", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo", providerId: "moonshot-intl", reasoningLevels: ["off"], contextWindow: 256000 },
  { id: "kimi-k2-0905-preview", name: "Kimi K2 0905", providerId: "moonshot-intl", reasoningLevels: ["off"], contextWindow: 256000 },
  { id: "kimi-k2-thinking", name: "Kimi K2 Thinking", providerId: "moonshot-intl", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2.6", name: "Kimi K2.6", providerId: "kimi-for-coding", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "k2.6-code-preview", name: "Kimi K2.6 Code Preview", providerId: "kimi-for-coding", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
  { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo", providerId: "kimi-for-coding", reasoningLevels: ["off"], contextWindow: 256000 },
  { id: "kimi-k2-0905-preview", name: "Kimi K2 0905", providerId: "kimi-for-coding", reasoningLevels: ["off"], contextWindow: 256000 },
  { id: "kimi-k2-thinking", name: "Kimi K2 Thinking", providerId: "kimi-for-coding", reasoningLevels: TOGGLE_THINKING_LEVELS, contextWindow: 256000 },
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

export function getBuiltinModel(providerId: string, modelId: string): BuiltinModelDefinition | undefined {
  const overlayHit = dynamicOverlay.get(overlayKey(providerId, modelId))
    || (providerId === "openai" ? dynamicOverlay.get(overlayKey("openai-codex", modelId)) : undefined);
  if (overlayHit) return overlayHit;
  return BUILTIN_MODELS.find((model) => model.providerId === providerId && model.id === modelId)
    || (providerId === "openai"
      ? BUILTIN_MODELS.find((model) => model.providerId === "openai-codex" && model.id === modelId)
      : undefined);
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

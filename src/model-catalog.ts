import type { ReasoningEffort } from "./types.js";

export interface BuiltinProviderDefinition {
  id: string;
  name: string;
  baseURL: string;
  supportsOAuth?: boolean;
}

export interface BuiltinModelDefinition {
  id: string;
  name: string;
  providerId: string;
  reasoningLevels: ReasoningEffort[];
}

export const BUILTIN_PROVIDERS: BuiltinProviderDefinition[] = [
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", supportsOAuth: true },
  { id: "openai-codex", name: "OpenAI Codex (ChatGPT)", baseURL: "https://chatgpt.com/backend-api" },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1" },
  { id: "google", name: "Google", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  { id: "together", name: "Together AI", baseURL: "https://api.together.xyz/v1" },
  { id: "local", name: "Local (OpenAI-compatible)", baseURL: "http://localhost:11434/v1" },
];

const ALL_OPENAI_LEVELS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const GPT51_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high"];
const GPT51_CODEX_MAX_LEVELS: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh"];
const GPT51_CODEX_MINI_LEVELS: ReasoningEffort[] = ["off", "medium", "high"];
const OPENAI_CHAT_LEVELS: ReasoningEffort[] = ["off"];

export const BUILTIN_MODELS: BuiltinModelDefinition[] = [
  { id: "gpt-5.4", name: "gpt-5.4", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS },
  { id: "gpt-5.4-mini", name: "gpt-5.4-mini", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS },
  { id: "gpt-5.3-codex", name: "gpt-5.3-codex", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS },
  { id: "gpt-5.3-codex-spark", name: "gpt-5.3-codex-spark", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS },
  { id: "gpt-5.2-codex", name: "gpt-5.2-codex", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS },
  { id: "gpt-5.2", name: "gpt-5.2", providerId: "openai-codex", reasoningLevels: ALL_OPENAI_LEVELS },
  { id: "gpt-5.1-codex-max", name: "gpt-5.1-codex-max", providerId: "openai-codex", reasoningLevels: GPT51_CODEX_MAX_LEVELS },
  { id: "gpt-5.1-codex-mini", name: "gpt-5.1-codex-mini", providerId: "openai-codex", reasoningLevels: GPT51_CODEX_MINI_LEVELS },
  { id: "gpt-5.1", name: "gpt-5.1", providerId: "openai-codex", reasoningLevels: GPT51_LEVELS },

  { id: "gpt-4o", name: "gpt-4o", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS },
  { id: "gpt-4o-mini", name: "gpt-4o-mini", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS },
  { id: "o1-preview", name: "o1-preview", providerId: "openai", reasoningLevels: ["off", "low", "medium", "high"] },
  { id: "o1-mini", name: "o1-mini", providerId: "openai", reasoningLevels: ["off", "low", "medium", "high"] },
  { id: "gpt-4-turbo", name: "gpt-4-turbo", providerId: "openai", reasoningLevels: OPENAI_CHAT_LEVELS },

  { id: "deepseek-chat", name: "deepseek-chat", providerId: "deepseek", reasoningLevels: ["off"] },
  { id: "deepseek-reasoner", name: "deepseek-reasoner", providerId: "deepseek", reasoningLevels: ["off"] },
  { id: "gemini-2.5-pro-preview-03-25", name: "gemini-2.5-pro-preview-03-25", providerId: "google", reasoningLevels: ["off", "low", "high"] },
  { id: "gemini-2.0-flash-001", name: "gemini-2.0-flash-001", providerId: "google", reasoningLevels: ["off"] },
  { id: "gemini-1.5-pro-latest", name: "gemini-1.5-pro-latest", providerId: "google", reasoningLevels: ["off"] },
  { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b-versatile", providerId: "groq", reasoningLevels: ["off"] },
  { id: "mixtral-8x7b-32768", name: "mixtral-8x7b-32768", providerId: "groq", reasoningLevels: ["off"] },
  { id: "gemma-2-9b-it", name: "gemma-2-9b-it", providerId: "groq", reasoningLevels: ["off"] },
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "meta-llama/Llama-3.3-70B-Instruct-Turbo", providerId: "together", reasoningLevels: ["off"] },
  { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen/Qwen2.5-72B-Instruct", providerId: "together", reasoningLevels: ["off"] },
  { id: "llama3.1", name: "llama3.1", providerId: "local", reasoningLevels: ["off"] },
  { id: "qwen2.5", name: "qwen2.5", providerId: "local", reasoningLevels: ["off"] },
  { id: "deepseek-coder-v2", name: "deepseek-coder-v2", providerId: "local", reasoningLevels: ["off"] },
];

export function listBuiltinModels(providerId: string): BuiltinModelDefinition[] {
  return BUILTIN_MODELS.filter((model) => model.providerId === providerId);
}

export function getBuiltinModel(providerId: string, modelId: string): BuiltinModelDefinition | undefined {
  return BUILTIN_MODELS.find((model) => model.providerId === providerId && model.id === modelId)
    || (providerId === "openai"
      ? BUILTIN_MODELS.find((model) => model.providerId === "openai-codex" && model.id === modelId)
      : undefined);
}

export function getBuiltinProvider(providerId: string): BuiltinProviderDefinition | undefined {
  return BUILTIN_PROVIDERS.find((provider) => provider.id === providerId);
}

/**
 * Multi-provider registry inspired by opencode.
 *
 * Supports OpenAI-compatible providers with dynamic or static model lists.
 */

import type { UserConfig } from "./config.js";

export interface ProviderProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

export const BUILTIN_PROVIDERS: Omit<ProviderProfile, "apiKey" | "enabled">[] = [
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1" },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1" },
  { id: "google", name: "Google", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  { id: "together", name: "Together AI", baseURL: "https://api.together.xyz/v1" },
  { id: "local", name: "Local (OpenAI-compatible)", baseURL: "http://localhost:11434/v1" },
];

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
}

const STATIC_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini", "gpt-4-turbo"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  google: ["gemini-2.5-pro-preview-03-25", "gemini-2.0-flash-001", "gemini-1.5-pro-latest"],
  groq: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768", "gemma-2-9b-it"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct"],
  local: ["llama3.1", "qwen2.5", "deepseek-coder-v2"],
};

export class ProviderRegistry {
  private config: UserConfig;

  constructor(config: UserConfig) {
    this.config = config;
  }

  getConfigured(): ProviderProfile[] {
    const providers = this.config.getProviders();
    if (!providers || providers.length === 0) {
      // Backward-compatible fallback: create OpenRouter from legacy apiKey
      return [{ ...BUILTIN_PROVIDERS[0], apiKey: this.config.getApiKey() || "", enabled: true }];
    }
    return providers;
  }

  getEnabled(): ProviderProfile[] {
    return this.getConfigured().filter((p) => p.enabled);
  }

  getDefault(): ProviderProfile | undefined {
    const enabled = this.getEnabled();
    const defaultId = this.config.getDefaultProvider();
    return enabled.find((p) => p.id === defaultId) || enabled[0];
  }

  setDefault(id: string) {
    this.config.setDefaultProvider(id);
  }

  addProvider(id: string, apiKey: string) {
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id);
    if (!builtin) return false;
    const providers = this.getConfigured();
    const idx = providers.findIndex((p) => p.id === id);
    const profile: ProviderProfile = { ...builtin, apiKey, enabled: true };
    if (idx >= 0) {
      providers[idx] = profile;
    } else {
      providers.push(profile);
    }
    this.config.setProviders(providers);
    return true;
  }

  removeProvider(id: string) {
    const providers = this.getConfigured().filter((p) => p.id !== id);
    this.config.setProviders(providers);
  }

  updateProviderKey(id: string, apiKey: string) {
    const providers = this.getConfigured();
    const p = providers.find((x) => x.id === id);
    if (p) {
      p.apiKey = apiKey;
      this.config.setProviders(providers);
    }
  }

  async listModels(provider: ProviderProfile): Promise<ModelInfo[]> {
    if (provider.id === "openrouter") {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/models");
        const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
        const models = data.data || [];
        return models.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          providerId: provider.id,
        }));
      } catch {
        // fall through to static
      }
    }
    const ids = STATIC_MODELS[provider.id] || [];
    return ids.map((id) => ({ id, name: id, providerId: provider.id }));
  }
}

/** Encode a model selection as "providerId:modelId". */
export function encodeModel(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/** Decode "providerId:modelId" or legacy plain modelId. */
export function decodeModel(value: string): { providerId?: string; modelId: string } {
  if (value.includes(":")) {
    const [providerId, ...rest] = value.split(":");
    return { providerId, modelId: rest.join(":") };
  }
  return { modelId: value };
}

/** Strip provider prefix for concise display. */
export function displayModel(model: string): string {
  const { modelId } = decodeModel(model);
  return modelId;
}

/** Normalize user input to provider:model format when possible. */
export function normalizeModel(model: string, defaultProvider = "openrouter"): string {
  const { providerId, modelId } = decodeModel(model);
  if (providerId) return model;
  return encodeModel(defaultProvider, modelId);
}

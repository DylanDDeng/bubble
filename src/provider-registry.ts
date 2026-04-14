/**
 * Multi-provider registry inspired by opencode and pi-mono.
 *
 * Supports OpenAI-compatible providers with dynamic or static model lists.
 * Reads provider configuration from models.json first, then falls back to config.json.
 */

import type { UserConfig } from "./config.js";
import { ModelConfig } from "./model-config.js";
import { AuthStorage } from "./oauth/index.js";
import { fetchOpenAICodexModels, getOpenAICodexFallbackModels } from "./provider-openai-codex.js";
import { refreshOpenAICodex } from "./oauth/openai-codex.js";

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
  { id: "openai-codex", name: "OpenAI Codex (ChatGPT)", baseURL: "https://chatgpt.com/backend-api" },
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

const OAUTH_PROVIDER_IDS = new Set(["openai-codex"]);
const OPENAI_CODEX_FALLBACK_MODELS = getOpenAICodexFallbackModels();

const STATIC_MODELS: Record<string, string[]> = {
  "openai-codex": OPENAI_CODEX_FALLBACK_MODELS,
  openai: ["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini", "gpt-4-turbo"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  google: ["gemini-2.5-pro-preview-03-25", "gemini-2.0-flash-001", "gemini-1.5-pro-latest"],
  groq: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768", "gemma-2-9b-it"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct"],
  local: ["llama3.1", "qwen2.5", "deepseek-coder-v2"],
};

export class ProviderRegistry {
  private config: UserConfig;
  private modelConfig: ModelConfig;
  private authStorage: AuthStorage;

  constructor(config: UserConfig) {
    this.config = config;
    this.modelConfig = new ModelConfig();
    this.authStorage = new AuthStorage();
  }

  getModelConfig(): ModelConfig {
    return this.modelConfig;
  }

  getAuthStorage(): AuthStorage {
    return this.authStorage;
  }

  supportsOAuth(providerId: string): boolean {
    return OAUTH_PROVIDER_IDS.has(providerId);
  }

  getDefaultModel(providerId: string): string | undefined {
    const customModels = this.modelConfig.getCustomModels(providerId);
    if (customModels.length > 0) {
      return customModels[0].id;
    }
    return STATIC_MODELS[providerId]?.[0];
  }

  async prepareProvider(providerId: string): Promise<void> {
    if (providerId === "openai-codex" && this.authStorage.isExpired("openai-codex")) {
      const creds = this.authStorage.get("openai-codex");
      if (creds?.refreshToken) {
        const refreshed = await refreshOpenAICodex(creds.refreshToken);
        this.authStorage.set("openai-codex", {
          type: "oauth",
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
          idToken: refreshed.idToken,
          accountId: refreshed.accountId,
        });
      }
    }
  }

  getConfigured(): ProviderProfile[] {
    // 1. Try models.json first (pi-mono style)
    const modelsJsonProviders = this.modelConfig.getAllProviders();
    const keys = Object.keys(modelsJsonProviders);
    let providers: ProviderProfile[] = [];

    if (keys.length > 0) {
      providers = keys.map((id) => {
        const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id);
        const cfg = modelsJsonProviders[id];
        return {
          id,
          name: builtin?.name || id,
          baseURL: cfg.baseURL || builtin?.baseURL || "",
          apiKey: cfg.apiKey || "",
          enabled: true,
        };
      });
    } else {
      // 2. Fall back to config.json providers (interactive TUI style)
      providers = this.config.getProviders();
    }

    // 3. Inject OAuth access tokens
    for (const p of providers) {
      if (!p.apiKey && this.authStorage.has(p.id)) {
        const token = this.authStorage.getAccessToken(p.id);
        if (token) {
          p.apiKey = token;
        }
      }
    }

    // 4. Auto-include built-in OAuth providers that have credentials
    const configuredIds = new Set(providers.map((p) => p.id));
    for (const builtin of BUILTIN_PROVIDERS) {
      if (configuredIds.has(builtin.id)) continue;
      if (this.authStorage.has(builtin.id)) {
        const token = this.authStorage.getAccessToken(builtin.id);
        providers.push({
          ...builtin,
          apiKey: token || "",
          enabled: !!token,
        });
      }
    }

    return providers;
  }

  getEnabled(): ProviderProfile[] {
    return this.getConfigured().filter((p) => p.enabled && p.apiKey);
  }

  getDefault(): ProviderProfile | undefined {
    const enabled = this.getEnabled();
    if (enabled.length === 0) return undefined;
    const defaultId = this.config.getDefaultProvider();
    return enabled.find((p) => p.id === defaultId) || enabled[0];
  }

  setDefault(id: string) {
    this.config.setDefaultProvider(id);
  }

  addProvider(id: string, apiKey: string) {
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id);
    if (!builtin) return false;
    const providers = this.config.getProviders();
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
    const providers = this.config.getProviders().filter((p) => p.id !== id);
    this.config.setProviders(providers);
  }

  updateProviderKey(id: string, apiKey: string) {
    const providers = this.config.getProviders();
    const p = providers.find((x) => x.id === id);
    if (p) {
      p.apiKey = apiKey;
      this.config.setProviders(providers);
    }
  }

  async listModels(provider: ProviderProfile): Promise<ModelInfo[]> {
    // 1. Custom models from models.json always take precedence
    const customModels = this.modelConfig.getCustomModels(provider.id);
    if (customModels.length > 0) {
      return customModels;
    }

    // 2. Built-in provider dynamic/static lists
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

    if (provider.id === "openai-codex" && provider.apiKey) {
      try {
        const models = await fetchOpenAICodexModels({
          baseURL: provider.baseURL,
          accessToken: provider.apiKey,
        });
        if (models.length > 0) {
          return models.map((id) => ({ id, name: id, providerId: provider.id }));
        }
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

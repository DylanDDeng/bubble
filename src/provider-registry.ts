/**
 * Multi-provider registry.
 *
 * Supports OpenAI-compatible providers with dynamic or static model lists.
 * Reads provider configuration from models.json first, then falls back to config.json.
 */

import type { UserConfig } from "./config.js";
import {
  BUILTIN_PROVIDERS as CATALOG_PROVIDERS,
  getBuiltinProvider,
  listBuiltinModels,
} from "./model-catalog.js";
import { ModelConfig } from "./model-config.js";
import { AuthStorage } from "./oauth/index.js";
import { fetchOpenAICodexModels } from "./provider-openai-codex.js";
import { refreshOpenAICodex } from "./oauth/openai-codex.js";

export interface ProviderProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
  authType?: "api" | "oauth";
}

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
}

export const BUILTIN_PROVIDERS = CATALOG_PROVIDERS;

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
    return !!getBuiltinProvider(providerId)?.supportsOAuth;
  }

  private resolveOAuthAuthKey(providerId: string): string {
    if (providerId === "openai" && !this.authStorage.has("openai") && this.authStorage.has("openai-codex")) {
      return "openai-codex";
    }
    return providerId;
  }

  getDefaultModel(providerId: string, authType: ProviderProfile["authType"] = "api"): string | undefined {
    const customModels = this.modelConfig.getCustomModels(providerId);
    if (customModels.length > 0) {
      return customModels[0].id;
    }
    if (providerId === "openai" && authType === "oauth") {
      return listBuiltinModels("openai-codex")[0]?.id;
    }
    return listBuiltinModels(providerId)[0]?.id;
  }

  async prepareProvider(providerId: string): Promise<void> {
    const authKey = this.resolveOAuthAuthKey(providerId);
    if (providerId === "openai" && this.authStorage.isExpired(authKey)) {
      const creds = this.authStorage.get(authKey);
      if (creds?.refreshToken) {
        const refreshed = await refreshOpenAICodex(creds.refreshToken);
        this.authStorage.set("openai", {
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
    // 1. Try models.json first
    const modelsJsonProviders = this.modelConfig.getAllProviders();
    const keys = Object.keys(modelsJsonProviders);
    let providers: ProviderProfile[] = [];

    if (keys.length > 0) {
      providers = keys.map((id) => {
        const builtin = getBuiltinProvider(id);
        const cfg = modelsJsonProviders[id];
        return {
          id,
          name: builtin?.name || id,
          baseURL: cfg.baseURL || builtin?.baseURL || "",
          apiKey: cfg.apiKey || "",
          enabled: true,
          authType: "api",
        };
      });
    } else {
      // 2. Fall back to config.json providers (interactive TUI style)
      providers = this.config.getProviders();
    }

    // 3. Inject OAuth access tokens
    for (const p of providers) {
      const authKey = this.resolveOAuthAuthKey(p.id);
      if (this.authStorage.has(authKey)) {
        const token = this.authStorage.getAccessToken(authKey);
        if (token) {
          p.apiKey = token;
          p.authType = "oauth";
          if (p.id === "openai") {
            p.baseURL = "https://chatgpt.com/backend-api";
          }
        }
      }
    }

    // 4. Auto-include built-in OAuth providers that have credentials
    const configuredIds = new Set(providers.map((p) => p.id));
    for (const builtin of BUILTIN_PROVIDERS) {
      if (builtin.id === "openai-codex") continue;
      if (configuredIds.has(builtin.id)) continue;
      const authKey = this.resolveOAuthAuthKey(builtin.id);
      if (this.authStorage.has(authKey)) {
        const token = this.authStorage.getAccessToken(authKey);
        providers.push({
          ...builtin,
          apiKey: token || "",
          enabled: !!token,
          authType: "oauth",
          ...(builtin.id === "openai" ? { baseURL: "https://chatgpt.com/backend-api" } : {}),
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
    const builtin = getBuiltinProvider(id);
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

    if (provider.id === "openai" && provider.authType === "oauth" && provider.apiKey) {
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
      return listBuiltinModels("openai-codex").map((model) => ({
        id: model.id,
        name: model.name,
        providerId: provider.id,
      }));
    }

    return listBuiltinModels(provider.id).map((model) => ({
      id: model.id,
      name: model.name,
      providerId: provider.id,
    }));
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

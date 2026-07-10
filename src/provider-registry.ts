/**
 * Multi-provider registry.
 *
 * Supports OpenAI-compatible providers with dynamic or static model lists.
 * Reads provider configuration from models.json first, then falls back to config.json.
 */

import { createHash } from "node:crypto";
import type { UserConfig } from "./config.js";
import {
  BUILTIN_PROVIDERS as CATALOG_PROVIDERS,
  clearDynamicModelMetadata,
  getBuiltinModel,
  getBuiltinProvider,
  listBuiltinModels,
  replaceDynamicModelMetadata,
  type ProviderProtocol,
} from "./model-catalog.js";
import { ModelConfig } from "./model-config.js";
import { AuthStorage } from "./oauth/index.js";
import { fetchGeminiModels } from "./provider-ai-sdk.js";
import { extractChatGptAccountId, fetchOpenAICodexModelCatalog, type OpenAICodexAuthAdapter } from "./provider-openai-codex.js";
import { refreshOpenAICodex } from "./oauth/openai-codex.js";
import type { OAuthCredentials } from "./oauth/types.js";
import type { ThinkingLevel } from "./types.js";

export interface ProviderProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
  authType?: "api" | "oauth";
  protocol?: ProviderProtocol;
}

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  reasoningLevels?: ThinkingLevel[];
  defaultReasoningLevel?: ThinkingLevel;
  contextWindow?: number;
  useResponsesLite?: boolean;
  toolOutputTokenLimit?: number;
}

export type ModelDiscoverySource = "remote" | "cache" | "static" | "fallback";

export interface ModelDiscoveryResult {
  models: ModelInfo[];
  source: ModelDiscoverySource;
  /** True when `models` is the complete list for this provider/account. */
  authoritative: boolean;
  error?: string;
}

interface CachedModelDiscovery {
  result: Omit<ModelDiscoveryResult, "source"> & { source: Exclude<ModelDiscoverySource, "cache"> };
  expiresAt: number;
}

const MODEL_DISCOVERY_SUCCESS_TTL_MS = 60_000;
const MODEL_DISCOVERY_FAILURE_TTL_MS = 10_000;

export const BUILTIN_PROVIDERS = CATALOG_PROVIDERS;
export const USER_VISIBLE_PROVIDER_IDS = BUILTIN_PROVIDERS
  .filter((provider) => !provider.hidden && provider.id !== "openrouter" && provider.id !== "openai-codex")
  .map((provider) => provider.id);

export function isUserVisibleProvider(providerId: string): boolean {
  return USER_VISIBLE_PROVIDER_IDS.includes(providerId);
}

export class ProviderRegistry {
  private config: UserConfig;
  private modelConfig: ModelConfig;
  private authStorage: AuthStorage;
  private modelDiscoveryCache = new Map<string, CachedModelDiscovery>();
  private modelDiscoveryInFlight = new Map<string, Promise<ModelDiscoveryResult>>();
  private modelDiscoveryGeneration = new Map<string, number>();

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
    if (providerId === "openai" || providerId === "openai-codex") {
      if (this.authStorage.has("openai")) return "openai";
      if (this.authStorage.has("openai-codex")) return "openai-codex";
    }
    return providerId;
  }

  createOpenAICodexAuthAdapter(providerId: string): OpenAICodexAuthAdapter | undefined {
    if (providerId !== "openai" && providerId !== "openai-codex") return undefined;
    if (!this.authStorage.has(this.resolveOAuthAuthKey(providerId))) return undefined;

    const readCredentials = (): OAuthCredentials | undefined =>
      this.authStorage.get(this.resolveOAuthAuthKey(providerId));

    let refreshPromise: Promise<OAuthCredentials> | undefined;
    return {
      getCredentials: readCredentials,
      isExpired: (_credentials, graceMs) =>
        this.authStorage.isExpired(this.resolveOAuthAuthKey(providerId), graceMs),
      refreshCredentials: async () => {
        if (!refreshPromise) {
          refreshPromise = (async () => {
            const authKey = this.resolveOAuthAuthKey(providerId);
            const current = this.authStorage.get(authKey);
            if (!current?.refreshToken) {
              throw new Error(`OpenAI OAuth credentials for ${providerId} are missing a refresh token.`);
            }
            const refreshed = await refreshOpenAICodex(current.refreshToken);
            const next: OAuthCredentials = {
              type: "oauth",
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
              idToken: refreshed.idToken || current.idToken,
              accountId: refreshed.accountId || current.accountId,
            };
            this.authStorage.set("openai", next);
            if (authKey !== "openai") {
              this.authStorage.set(authKey, next);
            }
            return next;
          })().finally(() => {
            refreshPromise = undefined;
          });
        }
        return refreshPromise;
      },
    };
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
    if ((providerId === "openai" || providerId === "openai-codex") && this.authStorage.isExpired(authKey)) {
      const creds = this.authStorage.get(authKey);
      if (creds?.refreshToken) {
        const refreshed = await refreshOpenAICodex(creds.refreshToken);
        const next: OAuthCredentials = {
          type: "oauth",
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
          idToken: refreshed.idToken || creds.idToken,
          accountId: refreshed.accountId || creds.accountId,
        };
        this.authStorage.set("openai", next);
        if (authKey !== "openai") {
          this.authStorage.set(authKey, next);
        }
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
        const baseURL = upgradeLegacyBaseURL(id, cfg.baseURL || builtin?.baseURL || "", cfg.protocol);
        return {
          id,
          name: builtin?.name || id,
          baseURL,
          apiKey: cfg.apiKey || "",
          enabled: true,
          authType: "api",
          protocol: resolveConfiguredProtocol(id, baseURL, cfg.protocol),
        };
      });
    } else {
      // 2. Fall back to config.json providers (interactive TUI style)
      providers = this.config.getProviders().map((provider) => {
        const baseURL = upgradeLegacyBaseURL(provider.id, provider.baseURL, provider.protocol);
        return {
          ...provider,
          baseURL,
          protocol: resolveConfiguredProtocol(provider.id, baseURL, provider.protocol),
        };
      });
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
    const preferred = enabled.filter((provider) => isUserVisibleProvider(provider.id));
    return preferred.find((p) => p.id === defaultId)
      || preferred[0]
      || enabled.find((p) => p.id === defaultId)
      || enabled[0];
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
    return (await this.discoverModels(provider)).models;
  }

  async discoverModels(
    provider: ProviderProfile,
    options: { forceRefresh?: boolean } = {},
  ): Promise<ModelDiscoveryResult> {
    const key = this.modelDiscoveryKey(provider);
    const now = Date.now();

    if (!options.forceRefresh) {
      const cached = this.modelDiscoveryCache.get(key);
      if (cached && cached.expiresAt > now) {
        const result: ModelDiscoveryResult = { ...cached.result, source: "cache" };
        const current = this.getConfigured().find((item) => item.id === provider.id);
        if (!current || this.modelDiscoveryKey(current) === key) {
          this.applyDynamicDiscoveryMetadata(provider, result);
        }
        return result;
      }
      const inFlight = this.modelDiscoveryInFlight.get(key);
      if (inFlight) return inFlight;
    } else {
      this.modelDiscoveryCache.delete(key);
      // Do not let a superseded request's finally-handler remove this retry.
      this.modelDiscoveryInFlight.delete(key);
    }

    const generation = (this.modelDiscoveryGeneration.get(provider.id) ?? 0) + 1;
    this.modelDiscoveryGeneration.set(provider.id, generation);

    let pending!: Promise<ModelDiscoveryResult>;
    pending = this.performModelDiscovery(provider).then((result): ModelDiscoveryResult => {
      if (!this.isCurrentModelDiscovery(provider, key, generation)) {
        return {
          models: this.localModelsForProvider(
            this.getConfigured().find((item) => item.id === provider.id) ?? provider,
          ),
          source: "fallback",
          authoritative: false,
          error: "Model catalog changed while it was refreshing.",
        };
      }

      this.applyDynamicDiscoveryMetadata(provider, result);
      this.modelDiscoveryCache.set(key, {
        result: { ...result, source: result.source === "cache" ? "remote" : result.source },
        expiresAt: Date.now() + (result.error ? MODEL_DISCOVERY_FAILURE_TTL_MS : MODEL_DISCOVERY_SUCCESS_TTL_MS),
      });
      return result;
    }).finally(() => {
      if (this.modelDiscoveryInFlight.get(key) === pending) {
        this.modelDiscoveryInFlight.delete(key);
      }
    });

    this.modelDiscoveryInFlight.set(key, pending);
    return pending;
  }

  private async performModelDiscovery(provider: ProviderProfile): Promise<ModelDiscoveryResult> {
    const customModels = this.modelConfig.getCustomModels(provider.id);
    if (customModels.length > 0) {
      return { models: customModels, source: "static", authoritative: true };
    }

    if (provider.id === "openrouter") {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
        return {
          models: (data.data ?? []).map((model) => ({
            id: model.id,
            name: model.name || model.id,
            providerId: provider.id,
          })),
          source: "remote",
          authoritative: true,
        };
      } catch (error) {
        return this.fallbackDiscovery(provider, error);
      }
    }

    if (provider.id === "google" && provider.protocol === "ai-sdk" && provider.apiKey) {
      try {
        const descriptors = await fetchGeminiModels({
          apiKey: provider.apiKey,
          baseURL: provider.baseURL,
        });
        return {
          models: descriptors.map((descriptor) => {
            const catalogEntry = getBuiltinModel("google", descriptor.id);
            return {
              id: descriptor.id,
              name: descriptor.name,
              providerId: provider.id,
              reasoningLevels: descriptor.reasoningLevels,
              defaultReasoningLevel: descriptor.defaultReasoningLevel ?? catalogEntry?.defaultReasoningLevel,
              contextWindow: descriptor.contextWindow ?? catalogEntry?.contextWindow,
            };
          }),
          source: "remote",
          authoritative: true,
        };
      } catch (error) {
        return this.fallbackDiscovery(provider, error);
      }
    }

    if (provider.id === "openai" && provider.authType === "oauth" && provider.apiKey) {
      try {
        await this.prepareProvider(provider.id);
        const currentProvider = this.getConfigured().find((item) => item.id === provider.id) ?? provider;
        const catalog = await fetchOpenAICodexModelCatalog({
          baseURL: currentProvider.baseURL,
          accessToken: currentProvider.apiKey,
        });
        if (catalog.status === "unavailable") {
          throw new Error("OpenAI Codex model catalog is unavailable.");
        }
        const visible = catalog.descriptors.filter((descriptor) => descriptor.visibility !== "hide");
        return {
          models: visible.map((descriptor) => {
            const catalogEntry = getBuiltinModel("openai-codex", descriptor.id);
            return {
              id: descriptor.id,
              name: descriptor.displayName || catalogEntry?.name || descriptor.id,
              providerId: provider.id,
              reasoningLevels: descriptor.reasoningLevels ?? catalogEntry?.reasoningLevels,
              defaultReasoningLevel: descriptor.defaultReasoningLevel ?? catalogEntry?.defaultReasoningLevel,
              contextWindow: descriptor.contextWindow ?? catalogEntry?.contextWindow,
              useResponsesLite: descriptor.useResponsesLite ?? catalogEntry?.useResponsesLite,
              toolOutputTokenLimit: descriptor.toolOutputTokenLimit ?? catalogEntry?.toolOutputTokenLimit,
            };
          }),
          source: "remote",
          authoritative: true,
        };
      } catch (error) {
        return this.fallbackDiscovery(provider, error);
      }
    }

    return {
      models: this.localModelsForProvider(provider),
      source: "static",
      authoritative: true,
    };
  }

  private fallbackDiscovery(provider: ProviderProfile, error: unknown): ModelDiscoveryResult {
    return {
      models: this.localModelsForProvider(provider),
      source: "fallback",
      authoritative: false,
      error: modelDiscoveryError(error),
    };
  }

  private localModelsForProvider(provider: ProviderProfile): ModelInfo[] {
    const customModels = this.modelConfig.getCustomModels(provider.id);
    if (customModels.length > 0) return customModels;
    const catalogProviderId = provider.id === "openai" && provider.authType === "oauth"
      ? "openai-codex"
      : provider.id;
    return listBuiltinModels(catalogProviderId).map((model) => ({
      id: model.id,
      name: model.name,
      providerId: provider.id,
      reasoningLevels: model.reasoningLevels,
      defaultReasoningLevel: model.defaultReasoningLevel,
      contextWindow: model.contextWindow,
      useResponsesLite: model.useResponsesLite,
      toolOutputTokenLimit: model.toolOutputTokenLimit,
    }));
  }

  private modelDiscoveryKey(provider: ProviderProfile): string {
    let identity = "anonymous";
    if (provider.id === "openai" && provider.authType === "oauth") {
      const credentials = this.authStorage.get(this.resolveOAuthAuthKey(provider.id));
      identity = credentials?.accountId
        || extractChatGptAccountId(provider.apiKey)
        || "unknown-account";
    } else if (provider.apiKey) {
      identity = createHash("sha256").update(provider.apiKey).digest("hex").slice(0, 16);
    }
    return JSON.stringify([
      provider.id,
      normalizeBaseURL(provider.baseURL),
      provider.authType ?? "api",
      provider.protocol ?? "default",
      identity,
    ]);
  }

  private isCurrentModelDiscovery(
    provider: ProviderProfile,
    key: string,
    generation: number,
  ): boolean {
    if (this.modelDiscoveryGeneration.get(provider.id) !== generation) return false;
    const current = this.getConfigured().find((item) => item.id === provider.id);
    return !current || this.modelDiscoveryKey(current) === key;
  }

  private applyDynamicDiscoveryMetadata(provider: ProviderProfile, result: ModelDiscoveryResult): void {
    const dynamicProviderId = provider.id === "openai" && provider.authType === "oauth"
      ? "openai-codex"
      : provider.id === "google" && provider.protocol === "ai-sdk"
        ? "google"
        : undefined;
    if (!dynamicProviderId) return;

    if (!result.authoritative) {
      clearDynamicModelMetadata(dynamicProviderId);
      return;
    }

    replaceDynamicModelMetadata(dynamicProviderId, result.models.map((model) => ({
      id: model.id,
      name: model.name,
      providerId: dynamicProviderId,
      // Empty means the remote model exists but declared no trusted effort metadata.
      reasoningLevels: model.reasoningLevels ?? [],
      defaultReasoningLevel: model.defaultReasoningLevel,
      contextWindow: model.contextWindow,
      useResponsesLite: model.useResponsesLite,
      toolOutputTokenLimit: model.toolOutputTokenLimit,
    })));
  }
}

function modelDiscoveryError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Remote model catalog is unavailable.";
}

/**
 * Builtin defaults that were captured into stored profiles before a builtin's
 * baseURL moved. Exactly these values are treated as "not customized" and
 * follow the builtin to its new address (and thereby its new protocol);
 * genuinely custom URLs and profiles with an explicit protocol are untouched.
 */
const LEGACY_BUILTIN_BASE_URLS: Record<string, string> = {
  // google moved from the Gemini OpenAI-compat endpoint to the native API
  // when the "ai-sdk" protocol landed.
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

function upgradeLegacyBaseURL(providerId: string, baseURL: string, explicitProtocol?: ProviderProtocol): string {
  if (explicitProtocol) return baseURL;
  const legacy = LEGACY_BUILTIN_BASE_URLS[providerId];
  if (!legacy || normalizeBaseURL(baseURL) !== normalizeBaseURL(legacy)) return baseURL;
  return getBuiltinProvider(providerId)?.baseURL ?? baseURL;
}

function resolveConfiguredProtocol(providerId: string, baseURL: string, explicitProtocol?: ProviderProtocol): ProviderProtocol | undefined {
  if (explicitProtocol) return explicitProtocol;
  const builtin = getBuiltinProvider(providerId);
  if (!builtin?.protocol) return undefined;
  const normalizedBaseURL = normalizeBaseURL(baseURL);
  if (!normalizedBaseURL || normalizedBaseURL === normalizeBaseURL(builtin.baseURL)) {
    return builtin.protocol;
  }
  if (normalizedBaseURL.includes("/anthropic")) {
    return "anthropic-messages";
  }
  return undefined;
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "").toLowerCase();
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
  const { providerId, modelId } = decodeModel(model);
  return providerId ? getBuiltinModel(providerId, modelId)?.name ?? modelId : modelId;
}

/** Normalize user input to provider:model format when possible. */
export function normalizeModel(model: string, defaultProvider = "openai"): string {
  const { providerId, modelId } = decodeModel(model);
  if (providerId) return model;
  return encodeModel(defaultProvider, modelId);
}

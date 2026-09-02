/**
 * Multi-provider registry.
 *
 * Supports OpenAI-compatible providers with dynamic or static model lists.
 * Reads provider configuration from models.json first, then falls back to config.json.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "./bubble-home.js";
import type { UserConfig } from "./config.js";
import {
  BUILTIN_PROVIDERS as CATALOG_PROVIDERS,
  clearDynamicModelMetadata,
  getBuiltinModel,
  getBuiltinProvider,
  inferGrokModelMetadata,
  listBuiltinModels,
  replaceDynamicModelMetadata,
  type ProviderProtocol,
} from "./model-catalog.js";
import { ModelConfig } from "./model-config.js";
import { AuthStorage } from "./oauth/index.js";
import { fetchGeminiModels, geminiReasoningLevels } from "./provider-ai-sdk.js";
import { extractChatGptAccountId, fetchOpenAICodexModelCatalog, type OpenAICodexAuthAdapter } from "./provider-openai-codex.js";
import { fetchGrokSubscriptionModels, type GrokAuthAdapter } from "./provider-grok.js";
import { refreshOpenAICodex } from "./oauth/openai-codex.js";
import { refreshGrok } from "./oauth/grok.js";
import type { OAuthCredentials } from "./oauth/types.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";
import {
  filterProviderModels,
  OPENROUTER_MODEL_ID,
} from "./provider-model-policy.js";

export interface ProviderProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
  authType?: "api" | "oauth";
  protocol?: ProviderProtocol;
  /**
   * Extra request headers sent with every call to this provider. The knob for
   * client-identity gates: coding-plan endpoints commonly allowlist specific
   * User-Agent strings (Grok wants "grok-cli", plans that "support Claude
   * Code" check for its UA), so users can satisfy them from config without
   * code changes. Merged over protocol defaults; same-name keys win.
   */
  headers?: Record<string, string>;
}

/** True for providers speaking the OpenAI chat-completions protocol (the default). */
export function isOpenAICompatibleProtocol(protocol: ProviderProtocol | undefined): boolean {
  return protocol === undefined || protocol === "openai-chat";
}

/**
 * Ids that are clearly not text chat models. Vendors with one big catalog
 * (alibaba returns 236 entries) would otherwise flood the model picker.
 * Deliberately conservative: vision/preview chat models must pass.
 */
const NON_CHAT_ID_PATTERN =
  /(^|[-_/])(embed|embedding|embeddings|rerank|reranker|tts|asr|whisper|ocr|moderation|guard|image|video|audio|speech|voice|paint|draw)([-_/]|$)/i;

export function isLikelyChatModelId(id: string): boolean {
  return !NON_CHAT_ID_PATTERN.test(id);
}

/** GET {baseURL}/models, tolerating the common response shapes. */
async function fetchOpenAICompatibleModelIds(
  provider: ProviderProfile,
): Promise<Array<{ id: string; name?: string }>> {
  const base = provider.baseURL.replace(/\/+$/, "");
  const response = await fetch(`${base}/models`, {
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...(provider.headers ?? {}),
    },
    signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown; name?: unknown }>;
    models?: Array<{ id?: unknown; name?: unknown }>;
  };
  const entries = payload.data ?? payload.models ?? [];
  return entries
    .filter((entry): entry is { id: string; name?: string } =>
      typeof entry?.id === "string" && entry.id.trim().length > 0)
    .map((entry) => ({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : undefined,
    }));
}

/** Keep only string-valued headers; returns undefined for empty/invalid maps. */
export function sanitizeProviderHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && key.trim()) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  /** Within-provider capability/cost tier (models.json / catalog annotation). */
  tier?: import("./model-catalog.js").ModelTier;
  /** Deterministic within-tier routing order (models.json only). */
  routingPriority?: number;
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
  identityKey: string;
  providerId: string;
  authType?: ProviderProfile["authType"];
  protocol?: ProviderProtocol;
}

/**
 * Read-only view of the discovery cache for routing consumers
 * (docs/model-routing-design.md §1.4). `complete` is true only for a
 * successful remote discovery that returned the provider's full catalog —
 * static/fallback results are NEVER complete, regardless of the internal
 * `authoritative` flag (which historically marks static fallbacks true).
 */
export interface CachedDiscoverySnapshot {
  models: ModelInfo[];
  source: Exclude<ModelDiscoverySource, "cache">;
  complete: boolean;
  expiresAt: number;
  identityKey: string;
}

const MODEL_DISCOVERY_SUCCESS_TTL_MS = 60_000;
const MODEL_DISCOVERY_FAILURE_TTL_MS = 10_000;
/** How long a successful discovery survives on disk before a fresh fetch. */
const MODEL_DISCOVERY_DISK_TTL_MS = 24 * 60 * 60 * 1000;
/** Discovery must never delay startup or a model picker for long. */
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
// Included in the cache identity so a pre-single-model OpenRouter disk cache
// can never repopulate the picker with the old full remote catalog.
const OPENROUTER_CATALOG_SCOPE = "ox-alpha-only-v2";

const OPENROUTER_WIRE_EFFORTS = new Map<string, ThinkingLevel>([
  ["none", "off"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
]);

function openRouterReasoningMetadata(
  value: unknown,
  fallback: Pick<ModelInfo, "reasoningLevels" | "defaultReasoningLevel">,
): Pick<ModelInfo, "reasoningLevels" | "defaultReasoningLevel"> {
  const fallbackMetadata = {
    reasoningLevels: fallback.reasoningLevels,
    defaultReasoningLevel: fallback.defaultReasoningLevel,
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallbackMetadata;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.supported_efforts)) return fallbackMetadata;

  const declared = new Set<ThinkingLevel>();
  for (const effort of raw.supported_efforts) {
    if (typeof effort !== "string") continue;
    const mapped = OPENROUTER_WIRE_EFFORTS.get(effort);
    if (mapped) declared.add(mapped);
  }
  if (raw.mandatory === true) declared.delete("off");
  const reasoningLevels = THINKING_LEVELS.filter((level) => declared.has(level));
  if (reasoningLevels.length === 0) return fallbackMetadata;

  const rawDefault = typeof raw.default_effort === "string"
    ? OPENROUTER_WIRE_EFFORTS.get(raw.default_effort)
    : undefined;
  const defaultReasoningLevel = rawDefault && reasoningLevels.includes(rawDefault)
    ? rawDefault
    : fallback.defaultReasoningLevel && reasoningLevels.includes(fallback.defaultReasoningLevel)
      ? fallback.defaultReasoningLevel
      : reasoningLevels.includes("medium")
        ? "medium"
        : reasoningLevels[0];
  return { reasoningLevels, defaultReasoningLevel };
}

export const BUILTIN_PROVIDERS = CATALOG_PROVIDERS;
export const USER_VISIBLE_PROVIDER_IDS = BUILTIN_PROVIDERS
  .filter((provider) => !provider.hidden && provider.id !== "openai-codex")
  .map((provider) => provider.id);

export function isUserVisibleProvider(providerId: string): boolean {
  return USER_VISIBLE_PROVIDER_IDS.includes(providerId);
}

export class ProviderRegistry {
  private config: UserConfig;
  private modelConfig: ModelConfig;
  private authStorage: AuthStorage;
  private modelDiscoveryCache = new Map<string, CachedModelDiscovery>();
  private readonly discoveryDiskCachePath = join(getBubbleHome(), "model-discovery-cache.json");
  private modelDiscoveryInFlight = new Map<string, Promise<ModelDiscoveryResult>>();
  private modelDiscoveryGeneration = new Map<string, number>();
  /** Last membership seen per discovery key — survives cache eviction/TTL so
   *  a re-discovery with identical membership never bumps the revision. */
  private lastDiscoveryMembership = new Map<string, { ids: string[]; authoritative: boolean }>();
  private routingRevision = 0;
  private identityFingerprints = new Map<string, string>();

  constructor(config: UserConfig) {
    this.config = config;
    this.modelConfig = new ModelConfig();
    this.authStorage = new AuthStorage();
    for (const authKey of this.authStorage.list()) {
      const fingerprint = this.credentialFingerprint(authKey);
      if (fingerprint) this.identityFingerprints.set(authKey, fingerprint);
    }
    this.authStorage.onMutation((authKey) => this.handleAuthMutation(authKey));
    this.loadDiscoveryDiskCache();
  }

  /** The on-disk cache is production-only; disable it under the test runner so
   *  tests sharing one isolated BUBBLE_HOME never contaminate each other. */
  private get discoveryDiskCacheEnabled(): boolean {
    const v = process.env.VITEST?.trim().toLowerCase();
    return v !== "true" && v !== "1";
  }

  /** Restore a prior successful discovery so dynamic models resolve without a
   *  network round-trip right after startup (no fetch on every launch). */
  private loadDiscoveryDiskCache(): void {
    if (!this.discoveryDiskCacheEnabled) return;
    try {
      if (!existsSync(this.discoveryDiskCachePath)) return;
      const parsed = JSON.parse(readFileSync(this.discoveryDiskCachePath, "utf8")) as Record<string, {
        result?: CachedModelDiscovery["result"];
        expiresAt?: number;
        identityKey?: string;
        providerId?: string;
        authType?: ProviderProfile["authType"];
        protocol?: ProviderProtocol;
      }>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= now) continue;
        if (!entry.result || !Array.isArray(entry.result.models)) continue;
        const provider = { id: entry.providerId ?? "", authType: entry.authType, protocol: entry.protocol };
        // Capability fields may have been derived by an older Bubble build.
        // Recompute them with the current code while retaining cached remote
        // membership, display names and context windows.
        const result = normalizeProviderDiscoveryMetadata(provider, entry.result);
        this.modelDiscoveryCache.set(key, {
          result,
          expiresAt: entry.expiresAt,
          identityKey: entry.identityKey ?? "unknown",
          providerId: provider.id,
          authType: entry.authType,
          protocol: entry.protocol,
        });
        // Rebuild the dynamic overlay so context window / reasoning levels
        // resolve from the cached catalog at startup, not only on /model open.
        if (entry.providerId) {
          this.applyDynamicDiscoveryMetadata(provider, result);
        }
      }
    } catch {
      // Missing/corrupt cache is fine; the next discovery re-fetches.
    }
  }

  /** Persist successful discoveries so the next launch can reuse them. */
  private saveDiscoveryDiskCache(): void {
    if (!this.discoveryDiskCacheEnabled) return;
    try {
      const data: Record<string, unknown> = {};
      for (const [key, entry] of this.modelDiscoveryCache) {
        if (entry.result.error) continue;
        data[key] = {
          result: entry.result,
          expiresAt: Date.now() + MODEL_DISCOVERY_DISK_TTL_MS,
          identityKey: entry.identityKey,
          providerId: entry.providerId,
          authType: entry.authType,
          protocol: entry.protocol,
        };
      }
      mkdirSync(dirname(this.discoveryDiskCachePath), { recursive: true });
      writeFileSync(this.discoveryDiskCachePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
      // Persistence is best-effort.
    }
  }

  /**
   * Monotonic counter of semantic routing-world changes: provider set,
   * credential identity, provider key/config, discovery membership.
   * Same-account OAuth token rotation deliberately does NOT bump it
   * (docs/model-routing-design.md §1.6).
   */
  getRoutingRevision(): number {
    return this.routingRevision;
  }

  private bumpRoutingRevision(): void {
    this.routingRevision++;
  }

  /** Stable identity for stored credentials: account id, else refresh-token hash. */
  private credentialFingerprint(authKey: string): string | undefined {
    const credentials = this.authStorage.get(authKey);
    if (!credentials) return undefined;
    if (credentials.accountId) return credentials.accountId;
    const stable = credentials.refreshToken || credentials.accessToken;
    return createHash("sha256").update(stable).digest("hex").slice(0, 16);
  }

  private handleAuthMutation(authKey: string): void {
    const next = this.credentialFingerprint(authKey);
    const prev = this.identityFingerprints.get(authKey);
    if (next === prev) return; // same-identity token rotation: not a routing change
    if (next === undefined) {
      this.identityFingerprints.delete(authKey);
    } else {
      this.identityFingerprints.set(authKey, next);
    }
    this.bumpRoutingRevision();
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

  createGrokAuthAdapter(providerId: string): GrokAuthAdapter | undefined {
    if (providerId !== "grok" || !this.authStorage.has("grok")) return undefined;

    let refreshPromise: Promise<OAuthCredentials> | undefined;
    return {
      getCredentials: () => this.authStorage.get("grok"),
      isExpired: (_credentials, graceMs) => this.authStorage.isExpired("grok", graceMs),
      refreshCredentials: async () => {
        if (!refreshPromise) {
          refreshPromise = (async () => {
            const current = this.authStorage.get("grok");
            if (!current?.refreshToken) {
              throw new Error("Grok OAuth credentials are missing a refresh token. Run /login grok again.");
            }
            const refreshed = await refreshGrok(current.refreshToken);
            const next: OAuthCredentials = {
              type: "oauth",
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
            };
            this.authStorage.set("grok", next);
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
    const customModels = filterProviderModels(providerId, this.modelConfig.getCustomModels(providerId));
    if (customModels.length > 0) {
      return customModels[0].id;
    }
    if (providerId === "openai" && authType === "oauth") {
      return listBuiltinModels("openai-codex")[0]?.id;
    }
    return listBuiltinModels(providerId)[0]?.id;
  }

  async prepareProvider(providerId: string): Promise<void> {
    if (providerId === "grok" && this.authStorage.isExpired("grok")) {
      const creds = this.authStorage.get("grok");
      if (creds?.refreshToken) {
        const refreshed = await refreshGrok(creds.refreshToken);
        this.authStorage.set("grok", {
          type: "oauth",
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        });
      }
      return;
    }
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
          headers: sanitizeProviderHeaders(cfg.headers),
        };
      });
    } else {
      // 2. Fall back to config.json providers (interactive TUI style)
      providers = this.config.getProviders().map((provider) => {
        // config.json entries may omit baseURL (a bare {id, apiKey} written
        // by minimal setups / benchmark harnesses); merge the builtin default
        // the same way the models.json path above does, instead of propagating
        // undefined into provider construction.
        const builtinBase = getBuiltinProvider(provider.id)?.baseURL ?? "";
        const rawBaseURL = provider.baseURL || builtinBase;
        const baseURL = upgradeLegacyBaseURL(provider.id, rawBaseURL, provider.protocol);
        return {
          ...provider,
          baseURL,
          protocol: resolveConfiguredProtocol(provider.id, baseURL, provider.protocol),
          headers: sanitizeProviderHeaders(provider.headers),
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
    this.bumpRoutingRevision();
    return true;
  }

  removeProvider(id: string) {
    const providers = this.config.getProviders().filter((p) => p.id !== id);
    this.config.setProviders(providers);
    this.bumpRoutingRevision();
  }

  updateProviderKey(id: string, apiKey: string) {
    const providers = this.config.getProviders();
    const p = providers.find((x) => x.id === id);
    if (p) {
      p.apiKey = apiKey;
      this.config.setProviders(providers);
      this.bumpRoutingRevision();
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
        const cachedResult = normalizeProviderDiscoveryMetadata(provider, cached.result);
        cached.result = cachedResult;
        // A disk cache can outlive the application version that wrote it. Keep
        // the current curated catalog authoritative over stale cached metadata,
        // then retain cached remote-only ids for non-authoritative union results.
        // This lets newly-added builtins surface immediately after an upgrade
        // without waiting up to 24 hours or requiring a manual Ctrl+R refresh.
        const local = this.localModelsForProvider(provider);
        const localIds = new Set(local.map((model) => model.id));
        const models = cachedResult.source === "static"
          ? local
          : cachedResult.authoritative
            ? cachedResult.models
            : [...local, ...cachedResult.models.filter((model) => !localIds.has(model.id))];
        const result: ModelDiscoveryResult = { ...cachedResult, models, source: "cache" };
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
    pending = this.performModelDiscovery(provider).then((rawResult): ModelDiscoveryResult => {
      const result = normalizeProviderDiscoveryMetadata(provider, rawResult);
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
      const previous = this.lastDiscoveryMembership.get(key);
      this.modelDiscoveryCache.set(key, {
        result: { ...result, source: result.source === "cache" ? "remote" : result.source },
        expiresAt: Date.now() + (result.error ? MODEL_DISCOVERY_FAILURE_TTL_MS : MODEL_DISCOVERY_SUCCESS_TTL_MS),
        identityKey: this.discoveryIdentity(provider),
        providerId: provider.id,
        authType: provider.authType,
        protocol: provider.protocol,
      });
      if (!result.error) this.saveDiscoveryDiskCache();
      this.lastDiscoveryMembership.set(key, {
        ids: result.models.map((model) => model.id),
        authoritative: result.authoritative,
      });
      if (discoveryMembershipChanged(previous, result)) {
        this.bumpRoutingRevision();
      }
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
    const customModels = filterProviderModels(
      provider.id,
      this.modelConfig.getCustomModels(provider.id),
    );
    if (customModels.length > 0) {
      return { models: customModels, source: "static", authoritative: true };
    }

    if (provider.id === "openrouter") {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as {
          data?: Array<{
            id?: unknown;
            name?: unknown;
            context_length?: unknown;
            supported_parameters?: unknown;
            reasoning?: unknown;
          }>;
        };
        const local = this.localModelsForProvider(provider);
        const fallback = local.find((model) => model.id === OPENROUTER_MODEL_ID);
        const remote = (data.data ?? []).find((model) => model?.id === OPENROUTER_MODEL_ID);
        if (!remote || !fallback) {
          return { models: local, source: "static", authoritative: true };
        }
        const reasoning = openRouterReasoningMetadata(remote.reasoning, fallback);
        return {
          models: [{
            ...fallback,
            name: typeof remote.name === "string" && remote.name.trim() ? remote.name : fallback.name,
            ...reasoning,
            contextWindow: typeof remote.context_length === "number" && remote.context_length > 0
              ? remote.context_length
              : fallback.contextWindow,
          }],
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

    // Grok subscription: the CLI chat proxy gates on the grok-cli identity
    // headers and a fresh OAuth bearer, neither of which the generic path below
    // sends. Discover through the refreshing subscription fetch, then merge the
    // curated catalog with any remote-only ids so newly-released models surface
    // without a code change. Authoritative because the merged list is what the
    // routing catalog and model picker should treat as the account's catalog.
    if (provider.id === "grok" && provider.authType === "oauth" && provider.apiKey) {
      try {
        await this.prepareProvider("grok");
        const currentProvider = this.getConfigured().find((item) => item.id === "grok") ?? provider;
        const grokAuth = this.createGrokAuthAdapter("grok");
        if (!grokAuth) throw new Error("Grok OAuth credentials are unavailable.");
        const remote = await fetchGrokSubscriptionModels(currentProvider.baseURL, grokAuth);
        const local = this.localModelsForProvider(currentProvider);
        const known = new Set(local.map((model) => model.id));
        const extras: ModelInfo[] = remote
          .filter((entry) => !known.has(entry.id) && isLikelyChatModelId(entry.id))
          .map((entry) => {
            const inferred = inferGrokModelMetadata(entry.id);
            // Prefer the server-declared effort ladder and context window over
            // id-based inference; fall back to inference only when the endpoint
            // omitted them (or for ids that don't match a known family).
            const levels = entry.reasoningEfforts && entry.reasoningEfforts.length > 0
              ? entry.reasoningEfforts
              : inferred.levels;
            const defaultLevel = entry.defaultReasoningEffort && levels.includes(entry.defaultReasoningEffort)
              ? entry.defaultReasoningEffort
              : inferred.defaultLevel;
            return {
              id: entry.id,
              name: entry.name || entry.id,
              providerId: currentProvider.id,
              reasoningLevels: levels,
              ...(defaultLevel ? { defaultReasoningLevel: defaultLevel } : {}),
              ...(entry.contextWindow !== undefined
                ? { contextWindow: entry.contextWindow }
                : inferred.contextWindow !== undefined
                  ? { contextWindow: inferred.contextWindow }
                  : {}),
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id));
        return {
          models: [...local, ...extras],
          source: "remote",
          authoritative: true,
        };
      } catch (error) {
        return this.fallbackDiscovery(provider, error);
      }
    }

    // Generic OpenAI-compatible discovery: most vendors expose GET /models on
    // the same base URL. Probed against every configured provider, their lists
    // turned out to be neither complete nor clean — zhipuai omits glm-5.2,
    // stepfun omits step-3.7-flash (both demonstrably usable), alibaba returns
    // 236 entries including image/audio models, fireworks 412s. So the remote
    // list AUGMENTS the curated catalog instead of replacing it: builtin
    // entries always survive (they carry tier/reasoning metadata and some work
    // while unlisted), remote-only ids are appended, obvious non-chat
    // modalities are filtered out. Not authoritative — membership is a union,
    // so nothing downstream may treat it as a closed allowlist.
    if (isOpenAICompatibleProtocol(provider.protocol) && provider.apiKey) {
      try {
        const remote = await fetchOpenAICompatibleModelIds(provider);
        const local = this.localModelsForProvider(provider);
        const known = new Set(local.map((model) => model.id));
        const extras: ModelInfo[] = remote
          .filter((entry) => !known.has(entry.id) && isLikelyChatModelId(entry.id))
          .map((entry) => ({
            id: entry.id,
            name: entry.name || entry.id,
            providerId: provider.id,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (extras.length === 0) {
          return { models: local, source: "static", authoritative: true };
        }
        return { models: [...local, ...extras], source: "remote", authoritative: false };
      } catch {
        // Vendors that don't implement /models (or gate it) fall back silently:
        // the curated catalog is the contract, discovery is a bonus.
        return { models: this.localModelsForProvider(provider), source: "static", authoritative: true };
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
    const customModels = filterProviderModels(
      provider.id,
      this.modelConfig.getCustomModels(provider.id),
    );
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
      tier: model.tier,
      useResponsesLite: model.useResponsesLite,
      toolOutputTokenLimit: model.toolOutputTokenLimit,
    }));
  }

  private discoveryIdentity(provider: ProviderProfile): string {
    if (provider.id === "openai" && provider.authType === "oauth") {
      const credentials = this.authStorage.get(this.resolveOAuthAuthKey(provider.id));
      return credentials?.accountId
        || extractChatGptAccountId(provider.apiKey)
        || "unknown-account";
    }
    if (provider.apiKey) {
      return createHash("sha256").update(provider.apiKey).digest("hex").slice(0, 16);
    }
    return "anonymous";
  }

  private modelDiscoveryKey(provider: ProviderProfile): string {
    return JSON.stringify([
      provider.id,
      normalizeBaseURL(provider.baseURL),
      provider.authType ?? "api",
      provider.protocol ?? "default",
      this.discoveryIdentity(provider),
      provider.id === "openrouter" ? OPENROUTER_CATALOG_SCOPE : undefined,
    ]);
  }

  /**
   * Read-only view of the cached discovery result for the provider's CURRENT
   * configuration/identity (docs/model-routing-design.md §1.4). Returns
   * undefined when nothing is cached or the cache has expired. `complete` is
   * derived strictly: only a successful full remote catalog qualifies —
   * never static or fallback results, whose internal `authoritative` flag
   * this design does not trust.
   */
  getCachedDiscoverySnapshot(providerId: string): CachedDiscoverySnapshot | undefined {
    const provider = this.getConfigured().find((item) => item.id === providerId);
    if (!provider) return undefined;
    const cached = this.modelDiscoveryCache.get(this.modelDiscoveryKey(provider));
    if (!cached || cached.expiresAt <= Date.now()) return undefined;
    return {
      models: cached.result.models,
      source: cached.result.source,
      complete: cached.result.source === "remote" && cached.result.authoritative && !cached.result.error,
      expiresAt: cached.expiresAt,
      identityKey: cached.identityKey,
    };
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

  private applyDynamicDiscoveryMetadata(provider: Pick<ProviderProfile, "id" | "authType" | "protocol">, result: ModelDiscoveryResult): void {
    const dynamicProviderId = provider.id === "openai" && provider.authType === "oauth"
      ? "openai-codex"
      : provider.id === "google" && provider.protocol === "ai-sdk"
        ? "google"
        : provider.id === "grok"
          ? "grok"
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
      // A remote model with no trusted effort metadata still has to be
      // selectable: default it to the plain "off" level (no reasoning control)
      // rather than an empty ladder, which the model picker would render
      // "unavailable" and skip during arrow-key navigation.
      reasoningLevels: model.reasoningLevels ?? ["off"],
      defaultReasoningLevel: model.defaultReasoningLevel,
      contextWindow: model.contextWindow,
      useResponsesLite: model.useResponsesLite,
      toolOutputTokenLimit: model.toolOutputTokenLimit,
    })));
  }
}

/**
 * Remote Gemini discovery does not expose Bubble's reasoning ladder; that
 * metadata is inferred locally. Never trust a persisted inference across app
 * upgrades, or a corrected capability matrix can remain stale for the cache
 * TTL after restart.
 */
function normalizeProviderDiscoveryMetadata<T extends { models: ModelInfo[] }>(
  provider: Pick<ProviderProfile, "id" | "protocol">,
  result: T,
): T {
  if (provider.id !== "google" || provider.protocol !== "ai-sdk") return result;
  return {
    ...result,
    models: result.models.map((model) => model.id.startsWith("gemini-")
      ? { ...model, reasoningLevels: geminiReasoningLevels(model.id) }
      : model),
  };
}

function modelDiscoveryError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Remote model catalog is unavailable.";
}

/** True when a discovery write changes the routing world: member ids or completeness. */
function discoveryMembershipChanged(
  previous: { ids: string[]; authoritative: boolean } | undefined,
  next: ModelDiscoveryResult,
): boolean {
  if (!previous) return true;
  if (previous.authoritative !== next.authoritative) return true;
  const previousIds = new Set(previous.ids);
  if (previousIds.size !== next.models.length) return true;
  return next.models.some((model) => !previousIds.has(model.id));
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

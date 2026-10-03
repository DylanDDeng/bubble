import { app } from 'electron';
import { createHash } from 'node:crypto';
import { cancelBubbleOAuth, getBubbleOAuthState } from './bubble-oauth';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BubbleModelConfig, BubbleProvidersConfig } from '../../shared/types';
import {
  getBubbleSdk,
  loadBubbleProviderCatalog,
  reloadBubbleSdkConfig,
  type BubbleModelInfo,
  type BubbleProviderProfile,
  type BubbleSdkInstance,
} from './provider/bubble-sdk-loader';

type BubbleAvailableModel = BubbleModelConfig['availableModels'][number];

const EMPTY_BUBBLE_MODEL_CONFIG: BubbleModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// ── Model catalog: instant local read + background live refresh ────────────
//
// Live model discovery hits each provider's HTTP endpoint and can take ~5s
// per unreachable provider, so it must never block the picker. The picker's
// data is assembled from local sources only:
// OpenAI uses only confirmed remote membership, never the builtin catalog.
// Other providers retain their existing local catalog contract:
//   1. the SDK's builtin static catalog / the user's models.json
//      (registry.localModelsForProvider — no network),
//   2. the last successful live discovery, persisted on disk.
// refreshBubbleModelCatalog() re-runs live discovery in the background,
// persists the result, and reports whether anything changed so the caller
// can broadcast bubble.modelCatalogUpdated (the codex pattern).

function bubbleModelDiskCachePath(): string | null {
  try {
    return join(app.getPath('userData'), 'bubble-model-catalog-cache.json');
  } catch {
    return null; // non-Electron context (standalone probes/tests)
  }
}

function modelCacheIdentity(profile: BubbleProviderProfile): string {
  let identity = profile.apiKey;
  if (profile.id === 'openai' && profile.authType === 'oauth' && typeof profile.apiKey === 'string') {
    try {
      const payload = JSON.parse(Buffer.from(profile.apiKey.split('.')[1], 'base64url').toString('utf8'));
      const auth = payload['https://api.openai.com/auth'];
      const account = auth?.chatgpt_account_id || auth?.account_id;
      if (typeof account === 'string' && account) identity = JSON.stringify([account, payload.sub || '']);
    } catch { /* Opaque tokens stay isolated by token hash. */ }
  }
  return createHash('sha256').update(JSON.stringify([profile.authType || 'api', profile.baseURL, identity])).digest('hex');
}

const catalogFailures = new Map<string, string>();

function readBubbleModelDiskCache(cachePath: string | null, profiles: Map<string, BubbleProviderProfile>): Record<string, BubbleModelInfo[]> {
  if (!cachePath || !existsSync(cachePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
      providers?: Record<string, BubbleModelInfo[]>;
      identities?: Record<string, string>;
      confirmedRemoteProviders?: string[];
    };
    // API and subscription accounts have different catalogs. Old/unmatched
    // cache entries must not leak models from the previous authentication mode.
    return Object.fromEntries(Object.entries(parsed.providers || {}).filter(([id]) => {
      const profile = profiles.get(id);
      return profile && Array.isArray(parsed.providers?.[id])
        && (id !== 'openai' || parsed.confirmedRemoteProviders?.includes(id))
        && parsed.identities?.[id] === modelCacheIdentity(profile);
    }));
  } catch {
    return {};
  }
}

function addModel(
  modelsByName: Map<string, BubbleAvailableModel>,
  providerId: string,
  model: BubbleModelInfo
): void {
  const name = formatBubbleModelId(providerId, model);
  if (!name || modelsByName.has(name)) {
    return;
  }
  modelsByName.set(name, {
    name,
    label: model.name?.trim() || name,
    provider: (model.providerId || providerId || '').trim() || null,
    enabled: true,
    isDefault: false,
    maxContextSize: typeof model.contextWindow === 'number' ? model.contextWindow : null,
    capabilities: [],
    // Thinking-level metadata straight from the SDK catalog: the composer's
    // Reasoning picker lists these per model, defaultReasoningLevel seeds it.
    reasoningLevels: (model.reasoningLevels || []).filter(
      (level) => typeof level === 'string' && level.trim().length > 0
    ),
    defaultReasoningLevel: model.defaultReasoningLevel?.trim() || null,
  });
}

type BubbleDiscoveryContext = {
  sdk: BubbleSdkInstance;
  defaultModel: string | null;
  configuredIds: string[];
  profiles: Map<string, BubbleProviderProfile>;
};

async function getBubbleDiscoveryContext(sdkOverride?: BubbleSdkInstance): Promise<BubbleDiscoveryContext> {
  const sdk = sdkOverride ?? await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  const config = sdk.getModelConfig();
  return {
    sdk,
    defaultModel: config.defaultModel?.trim() || null,
    configuredIds: config.providers.filter((provider) => provider.hasApiKey).map((p) => p.id),
    profiles: new Map<string, BubbleProviderProfile>(
      sdk.registry.getEnabled().map((profile) => [profile.id, profile])
    ),
  };
}

function confirmedOpenAIModels(sdk: BubbleSdkInstance): BubbleModelInfo[] | undefined {
  const snapshot = sdk.registry.getCachedDiscoverySnapshot('openai', { allowExpiredConfirmation: true });
  return snapshot?.complete ? snapshot.models : undefined;
}

export async function getBubbleModelConfig(sdkOverride?: BubbleSdkInstance): Promise<BubbleModelConfig> {
  let defaultModel: string | null = null;
  const modelsByName = new Map<string, BubbleAvailableModel>();
  let catalogNotice: string | undefined;
  try {
    const context = await getBubbleDiscoveryContext(sdkOverride);
    defaultModel = context.defaultModel;
    const diskCache = readBubbleModelDiskCache(bubbleModelDiskCachePath(), context.profiles);
    for (const providerId of context.configuredIds) {
      const profile = context.profiles.get(providerId);
      if (!profile) {
        continue;
      }
      if (providerId === 'openai') {
        const cached = confirmedOpenAIModels(context.sdk) ?? diskCache[providerId];
        for (const model of cached ?? []) addModel(modelsByName, providerId, model);
        const failure = catalogFailures.get(modelCacheIdentity(profile));
        catalogNotice = failure
          ? cached !== undefined ? 'OpenAI model refresh failed. Using the last successful catalog.' : 'Could not load OpenAI models. Retry from provider settings.'
          : cached === undefined ? 'Loading OpenAI models…' : undefined;
        continue;
      }
      // Local catalog first (static builtin / models.json), then extras the
      // last live discovery found for this provider.
      let localModels: BubbleModelInfo[] = [];
      try {
        localModels = context.sdk.registry.localModelsForProvider(profile) || [];
      } catch {
        // unknown provider — disk-cached extras still apply
      }
      for (const model of localModels) {
        addModel(modelsByName, providerId, model);
      }
      for (const model of diskCache[providerId] || []) {
        addModel(modelsByName, providerId, model);
      }
    }
  } catch (error) {
    console.warn('[bubble-settings] Failed to load Bubble model config:', error);
    return EMPTY_BUBBLE_MODEL_CONFIG;
  }

  // A saved API default may not exist in the subscription catalog (and a
  // signed-out provider has no selectable models). Do not re-inject that model.
  if (defaultModel && !modelsByName.has(defaultModel)) defaultModel = null;

  const normalizedModels = Array.from(modelsByName.values()).map((model) => ({
    ...model,
    isDefault: defaultModel === model.name,
  }));

  return {
    defaultModel,
    options: normalizedModels.filter((model) => model.enabled).map((model) => model.name),
    availableModels: normalizedModels,
    catalogNotice,
  };
}

let bubbleCatalogRefreshInflight: Promise<boolean> | null = null;

/**
 * Live per-provider model discovery, run in the background. Persists the
 * merged catalog to disk and resolves true when it changed (caller then
 * broadcasts bubble.modelCatalogUpdated). Deduped: concurrent callers share
 * one run. Never throws.
 */
export function refreshBubbleModelCatalog(): Promise<boolean> {
  if (!bubbleCatalogRefreshInflight) {
    bubbleCatalogRefreshInflight = runBubbleModelCatalogRefresh()
      .catch((error) => {
        console.warn('[bubble-settings] Background Bubble model discovery failed:', error);
        return false;
      })
      .finally(() => {
        bubbleCatalogRefreshInflight = null;
      });
  }
  return bubbleCatalogRefreshInflight;
}

async function runBubbleModelCatalogRefresh(): Promise<boolean> {
  const context = await getBubbleDiscoveryContext();
  // Parallel: several providers take ~5s to time out when their endpoint is
  // unreachable, and a sequential loop over ~16 providers took ~26s.
  const discovered = await Promise.all(
    context.configuredIds.map(async (providerId) => {
      const profile = context.profiles.get(providerId);
      if (!profile) {
        return null;
      }
      try {
        if (providerId === 'openai') {
          const result = await context.sdk.registry.discoverModels(profile, { forceRefresh: true });
          if (result.error || !result.authoritative || !['remote', 'cache'].includes(result.source)) {
            return { providerId, models: confirmedOpenAIModels(context.sdk) ?? null, failed: true };
          }
          return { providerId, models: result.models };
        }
        const models = (await context.sdk.registry.listModels(profile)) || [];
        return { providerId, models };
      } catch (error) {
        console.warn(`[bubble-settings] Failed to list Bubble models for "${providerId}":`, error);
        return { providerId, models: providerId === 'openai' ? confirmedOpenAIModels(context.sdk) ?? null : null, failed: true };
      }
    })
  );

  // A sign-in/out may complete while remote discovery is in flight.
  const currentProfiles = new Map(context.sdk.registry.getEnabled().map(profile => [profile.id, profile]));
  if (context.profiles.size !== currentProfiles.size || [...context.profiles].some(([id, profile]) => {
    const current = currentProfiles.get(id);
    return !current || modelCacheIdentity(current) !== modelCacheIdentity(profile);
  })) return false;

  // Merge onto the previous cache: providers that failed this round keep
  // their last-known models; providers no longer configured are pruned.
  const previous = readBubbleModelDiskCache(bubbleModelDiskCachePath(), context.profiles);
  const merged: Record<string, BubbleModelInfo[]> = {};
  for (const providerId of context.configuredIds) {
    if (previous[providerId]) {
      merged[providerId] = previous[providerId];
    }
  }
  let refreshedCount = 0;
  let noticeChanged = false;
  for (const entry of discovered) {
    if (entry?.providerId === 'openai') {
      const identity = modelCacheIdentity(context.profiles.get(entry.providerId)!);
      const failed = entry.failed === true;
      noticeChanged = catalogFailures.has(identity) !== failed;
      if (failed) catalogFailures.set(identity, 'unavailable');
      else catalogFailures.delete(identity);
    }
    if (entry && entry.models !== null && (entry.providerId === 'openai' || entry.models.length > 0)) {
      merged[entry.providerId] = entry.models;
      refreshedCount += 1;
    }
  }
  if (refreshedCount === 0) {
    return noticeChanged; // total discovery failure — keep the previous cache intact
  }
  if (JSON.stringify(previous) === JSON.stringify(merged)) {
    return noticeChanged;
  }
  const cachePath = bubbleModelDiskCachePath();
  if (cachePath) {
    try {
      writeFileSync(cachePath, JSON.stringify({ updatedAt: Date.now(), providers: merged, confirmedRemoteProviders: Object.keys(merged).filter(id => id === 'openai'), identities: Object.fromEntries([...context.profiles].map(([id, profile]) => [id, modelCacheIdentity(profile)])) }));
    } catch (error) {
      console.warn('[bubble-settings] Failed to persist Bubble model catalog cache:', error);
    }
  }
  return true;
}

// The model identifier the app uses is "<provider>:<id>", matching Bubble's
// own encodeModel format that runTurn({ model }) resolves.
function formatBubbleModelId(providerId: string | undefined, model: BubbleModelInfo): string | null {
  const id = model.id?.trim();
  if (!id) {
    return null;
  }
  if (id.includes(':')) {
    return id;
  }
  const provider = (model.providerId || providerId || '').trim();
  return provider ? `${provider}:${id}` : id;
}

function hasStoredKey(profile: BubbleProviderProfile | undefined): boolean {
  return typeof profile?.apiKey === 'string' && profile.apiKey.trim().length > 0;
}

// The SDK catalog labels the two Moonshot endpoints in Chinese (国内/海外);
// the Aegis UI is English-only, so rename them here.
const PROVIDER_NAME_OVERRIDES: Record<string, string> = {
  'moonshot-cn': 'Moonshot (China)',
  'moonshot-intl': 'Moonshot (International)',
  'bailian-token-plan': 'Bailian Token Plan',
};

/**
 * Full stored key, fetched on demand when the user expands a provider's key
 * editor so the input can be prefilled (masked behind the password toggle).
 * Deliberately not part of getBubbleProvidersConfig — the bulk config only
 * carries a hasApiKey flag.
 */
export async function getBubbleProviderKey(providerId: string): Promise<string> {
  const sdk = await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  const profile = sdk.registry.getConfigured().find((entry) => entry.id === providerId);
  return profile?.authType !== 'oauth' && providerId !== 'grok' && typeof profile?.apiKey === 'string' ? profile.apiKey : '';
}

/**
 * Settings-page view over Bubble's provider credentials. Everything goes
 * through the SDK registry in the selected Bubble home. This bulk response
 * contains only authentication metadata; OAuth tokens never leave the host.
 */
export async function getBubbleProvidersConfig(): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  const catalog = await loadBubbleProviderCatalog();
  const configured = new Map(sdk.registry.getConfigured().map((profile) => [profile.id, profile]));
  const defaultProviderId = sdk.registry.getDefault()?.id || null;

  const providers = catalog.BUILTIN_PROVIDERS.filter(
    (definition) => !definition.hidden && catalog.isUserVisibleProvider(definition.id)
  ).map((definition) => {
    const profile = configured.get(definition.id);
    return {
      id: definition.id,
      name: PROVIDER_NAME_OVERRIDES[definition.id] || definition.name || definition.id,
      baseURL: (typeof profile?.baseURL === 'string' && profile.baseURL) || definition.baseURL,
      supportsOAuth: definition.supportsOAuth === true,
      oauthOnly: definition.id === 'grok',
      authType: (profile?.authType === 'oauth' ? 'oauth' : definition.id !== 'grok' && hasStoredKey(profile) ? 'api' : 'none') as 'oauth' | 'api' | 'none',
      hasApiKey: profile?.authType !== 'oauth' && definition.id !== 'grok' && hasStoredKey(profile),
      enabled: profile ? profile.enabled !== false : false,
      isDefault: definition.id === defaultProviderId,
      configured: Boolean(profile),
    };
  });

  return { providers, defaultProviderId };
}

export async function setBubbleProviderKey(
  providerId: string,
  apiKey: string
): Promise<BubbleProvidersConfig> {
  if (providerId === 'grok') throw new Error('Grok Subscription requires browser sign-in, not an API key.');
  if (getBubbleOAuthState().status === 'pending') throw new Error('Finish or cancel the current sign-in first.');
  const key = apiKey.trim();
  if (!key) {
    throw new Error('API key must not be empty.');
  }
  const sdk = await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  if (sdk.registry.getOAuthLoginKeys(providerId).length) throw new Error('Sign out of the subscription before switching to an API key.');
  if (!sdk.registry.addProvider(providerId, key)) {
    throw new Error(`Unknown Bubble provider "${providerId}".`);
  }
  return getBubbleProvidersConfig();
}

export async function removeBubbleProvider(providerId: string): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  if (getBubbleOAuthState().providerId === providerId) cancelBubbleOAuth();
  reloadBubbleSdkConfig(sdk);
  for (const key of sdk.registry.getOAuthLoginKeys(providerId)) sdk.registry.getAuthStorage().remove(key);
  sdk.registry.removeProvider(providerId);
  return getBubbleProvidersConfig();
}

export async function setBubbleDefaultProvider(providerId: string): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  sdk.registry.setDefault(providerId);
  return getBubbleProvidersConfig();
}

/**
 * Toggle a configured provider without touching its key. Disabled providers
 * are excluded from getModelConfig()/getEnabled(), so their models drop out
 * of the composer picker and the agent won't route to them.
 */
export async function setBubbleProviderEnabled(
  providerId: string,
  enabled: boolean
): Promise<BubbleProvidersConfig> {
  const sdk = await getBubbleSdk();
  reloadBubbleSdkConfig(sdk);
  const providers = sdk.userConfig.getProviders();
  let profile = providers.find((entry) => entry.id === providerId);
  if (!profile && sdk.registry.getOAuthLoginKeys(providerId).length) {
    // Persist only the enable preference, never the registry's injected token.
    profile = { id: providerId, enabled };
    providers.push(profile);
  }
  if (!profile) {
    throw new Error(`Bubble provider "${providerId}" is not configured.`);
  }
  profile.enabled = enabled;
  sdk.userConfig.setProviders(providers);
  return getBubbleProvidersConfig();
}



export async function logoutBubbleOAuth(providerId: string): Promise<BubbleProvidersConfig> {
  if (providerId !== 'openai' && providerId !== 'grok') throw new Error('Unsupported subscription provider.');
  if (getBubbleOAuthState().providerId === providerId) cancelBubbleOAuth();
  const sdk = await getBubbleSdk();
  for (const key of sdk.registry.getOAuthLoginKeys(providerId)) sdk.registry.getAuthStorage().remove(key);
  return getBubbleProvidersConfig();
}

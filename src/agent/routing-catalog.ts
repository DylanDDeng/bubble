/**
 * Routing catalog: the single source of catalog truth for subagent model
 * routing (docs/model-routing-design.md §1).
 *
 * No routing consumer reads `listBuiltinModels` / `getConfigured` directly —
 * neither reflects what is actually runnable. Consumers read a
 * `RoutingSnapshot` through the live accessor created here; the accessor
 * caches by the registry's routing revision and rebuilds lazily, so tier
 * resolution, validation, the detector, and the menu are never stale (§1.5).
 */

import {
  getBuiltinModel,
  listBuiltinModels,
  listDynamicModelMetadata,
  type ModelTier,
} from "../model-catalog.js";
import type { ProviderRegistry } from "../provider-registry.js";
import {
  mergeAgentCategoriesWithProvenance,
  resolveSubagentRoute,
  selectTierCandidates,
  type AgentCategoriesConfig,
  type TierCatalogEntry,
  type TierRoutingContext,
} from "./categories.js";
import type { ThinkingLevel } from "../types.js";
import { filterProviderModels } from "../provider-model-policy.js";

export interface AgentRoutingConfig {
  /** Automatic builtin-tier downgrade routing (§3.2). */
  autoTier: boolean;
  /** Call-site cross-provider routing; default open, set false to lock (§7.2). */
  allowCrossProvider: boolean;
}

export const DEFAULT_AGENT_ROUTING: AgentRoutingConfig = {
  autoTier: true,
  allowCrossProvider: true,
};

export function sanitizeAgentRouting(value: unknown): AgentRoutingConfig {
  const config = { ...DEFAULT_AGENT_ROUTING };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.autoTier === "boolean") config.autoTier = record.autoTier;
    if (typeof record.allowCrossProvider === "boolean") {
      config.allowCrossProvider = record.allowCrossProvider;
    }
  }
  return config;
}

export interface RoutingModelEntry {
  id: string;
  name: string;
  tier?: ModelTier;
  routingPriority?: number;
  /** Index in the builtin catalog order, when the id is builtin (§3.2 tiebreak). */
  builtinIndex?: number;
  source: "builtin" | "dynamic" | "custom";
}

export type RoutingMembershipSource = "custom-allowlist" | "complete-discovery" | "fallback-union";

export interface RoutingSnapshot {
  parent: { providerId: string; model: string; tier?: ModelTier };
  /**
   * Subscription (OAuth) catalogs are account-scoped: the server decides which
   * models this account may use, so only models the CURRENT identity's
   * discovery snapshot (or the user's models.json) confirmed may be chosen by
   * automatic tier routing. API-key providers keep their builtin tiers routable.
   */
  accountScopedCatalog: boolean;
  /** Models automatic tier routing may pick from (see accountScopedCatalog). */
  tierCatalog: TierCatalogEntry[];
  /** Catalog-effective provider id (openai OAuth -> "openai-codex" alias). */
  effectiveProviderId: string;
  membershipSource: RoutingMembershipSource;
  /** Model list for the PARENT provider only (§1.2 scope note). */
  models: RoutingModelEntry[];
  /** True iff membershipSource === "custom-allowlist" — the only catalog
   *  that hard-rejects unknown ids (§1.4). */
  authoritative: boolean;
  registryRevision: number;
  /**
   * Earliest expiry of the discovery data this snapshot consumed. TTL expiry
   * is passive — it bumps no revision — so the accessor must rebuild past
   * this instant or it serves a catalog the registry itself no longer would.
   */
  discoveryExpiresAt?: number;
  /** Provider ids with active credentials (getEnabled, §1.1). */
  runnableProviderIds: string[];
  /** Post-merge, post-tier-resolution category bindings (§3). */
  resolvedCategories: Array<{
    name: string;
    model: string | "inherit";
    thinkingLevel?: ThinkingLevel;
    tierSource?: "builtin" | "user";
  }>;
}

export type RoutingSnapshotAccessor = (
  parent: { providerId: string; model: string },
) => RoutingSnapshot;

/**
 * Membership versus metadata (§1.3): an authoritative source alone decides
 * which ids exist; lower-priority sources only enrich per-field metadata
 * (tier: dynamic ?? custom ?? builtin).
 */
export function buildRoutingSnapshot(
  registry: ProviderRegistry,
  parent: { providerId: string; model: string },
  agentCategories: AgentCategoriesConfig,
  agentRouting: AgentRoutingConfig,
): RoutingSnapshot {
  const configured = registry.getConfigured().find((item) => item.id === parent.providerId);
  const effectiveProviderId = parent.providerId === "openai" && configured?.authType === "oauth"
    ? "openai-codex"
    : parent.providerId;
  const accountScopedCatalog = configured?.authType === "oauth";

  const builtins = listBuiltinModels(effectiveProviderId);
  const builtinIndex = new Map(builtins.map((model, index) => [model.id, index]));
  const dynamic = listDynamicModelMetadata(effectiveProviderId);
  const custom = filterProviderModels(
    parent.providerId,
    registry.getModelConfig().getCustomModels(parent.providerId),
  );
  const discovery = registry.getCachedDiscoverySnapshot(parent.providerId);

  const metadataFor = (id: string): Omit<RoutingModelEntry, "source"> => {
    const dynamicEntry = dynamic.find((model) => model.id === id);
    const discoveryEntry = discovery?.models.find((model) => model.id === id);
    const customEntry = custom.find((model) => model.id === id);
    const builtinEntry = builtins.find((model) => model.id === id);
    return {
      id,
      name: dynamicEntry?.name ?? discoveryEntry?.name ?? customEntry?.name ?? builtinEntry?.name ?? id,
      // Field-level merge (§1.3): discovery decides existence, but tier falls
      // back through custom to builtin when the fresher source omits it.
      tier: dynamicEntry?.tier ?? discoveryEntry?.tier ?? customEntry?.tier ?? builtinEntry?.tier,
      routingPriority: customEntry?.routingPriority,
      builtinIndex: builtinIndex.get(id),
    };
  };

  let membershipSource: RoutingMembershipSource;
  let memberIds: string[];
  const memberSource = new Map<string, RoutingModelEntry["source"]>();

  if (custom.length > 0) {
    membershipSource = "custom-allowlist";
    memberIds = custom.map((model) => model.id);
    for (const id of memberIds) memberSource.set(id, "custom");
  } else if (discovery && discovery.complete) {
    membershipSource = "complete-discovery";
    memberIds = discovery.models.map((model) => model.id);
    for (const id of memberIds) memberSource.set(id, "dynamic");
  } else {
    membershipSource = "fallback-union";
    memberIds = [];
    for (const model of dynamic) {
      if (!memberSource.has(model.id)) {
        memberSource.set(model.id, "dynamic");
        memberIds.push(model.id);
      }
    }
    for (const model of custom) {
      if (!memberSource.has(model.id)) {
        memberSource.set(model.id, "custom");
        memberIds.push(model.id);
      }
    }
    for (const model of builtins) {
      if (!memberSource.has(model.id)) {
        memberSource.set(model.id, "builtin");
        memberIds.push(model.id);
      }
    }
  }

  const models: RoutingModelEntry[] = memberIds.map((id) => ({
    ...metadataFor(id),
    source: memberSource.get(id) ?? "builtin",
  }));

  const parentTier = models.find((model) => model.id === parent.model)?.tier
    ?? getBuiltinModel(effectiveProviderId, parent.model)?.tier;

  const runnableProviderIds = registry.getEnabled().map((provider) => provider.id);
  // The dynamic overlay is provider-wide and is rebuilt from EVERY unexpired
  // disk-cache entry at startup (other accounts, older client pins included),
  // so "dynamic" membership alone does not prove this account can use a model.
  // Only the current identity's own discovery snapshot does.
  const tierCatalog = tierCatalogEntries(
    models,
    accountScopedCatalog,
    discovery ? new Set(discovery.models.map((model) => model.id)) : undefined,
  );

  return {
    parent: { ...parent, tier: parentTier },
    accountScopedCatalog,
    tierCatalog,
    effectiveProviderId,
    membershipSource,
    models,
    authoritative: membershipSource === "custom-allowlist",
    registryRevision: registry.getRoutingRevision(),
    discoveryExpiresAt: discovery?.expiresAt,
    runnableProviderIds,
    resolvedCategories: resolveCategoriesForMenu(
      parent,
      parentTier,
      tierCatalog,
      agentCategories,
      agentRouting,
    ),
  };
}

/**
 * Catalog visible to automatic tier routing. On an account-scoped catalog only
 * models confirmed by the current identity's discovery snapshot, or listed by
 * the user in models.json, are candidates. A builtin-only entry (e.g. a static
 * fast-tier model the ChatGPT plan does not include) or an overlay entry left
 * by another account's cache would otherwise be routed to and rejected
 * server-side. Without a snapshot nothing but user-listed models qualifies.
 */
export function tierCatalogEntries(
  models: readonly RoutingModelEntry[],
  accountScopedCatalog: boolean,
  confirmedIds?: ReadonlySet<string>,
): TierCatalogEntry[] {
  return models
    .filter((model) => (
      !accountScopedCatalog
      || model.source === "custom"
      || (confirmedIds?.has(model.id) ?? false)
    ))
    .map((model): TierCatalogEntry => ({
      id: model.id,
      tier: model.tier,
      routingPriority: model.routingPriority,
      builtinIndex: model.builtinIndex,
    }));
}

/** Tier-resolution context derived from a snapshot (consumed by categories §3.2). */
export function tierContextFromSnapshot(
  snapshot: RoutingSnapshot,
  agentRouting: AgentRoutingConfig,
): TierRoutingContext {
  return {
    parentTier: snapshot.parent.tier,
    models: snapshot.tierCatalog,
    autoTier: agentRouting.autoTier,
  };
}

/**
 * Live accessor (§1.5): caches by (routing revision, parent route) and
 * rebuilds lazily, so a discovery completion or provider mutation is
 * reflected at the very next read. Building is synchronous over cached
 * registry state — microseconds, never I/O.
 */
export function createRoutingSnapshotAccessor(
  registry: ProviderRegistry,
  getAgentCategories: () => AgentCategoriesConfig,
  getAgentRouting: () => AgentRoutingConfig,
): RoutingSnapshotAccessor {
  let cached: RoutingSnapshot | undefined;
  return (parent) => {
    if (
      cached
      && cached.registryRevision === registry.getRoutingRevision()
      && cached.parent.providerId === parent.providerId
      && cached.parent.model === parent.model
      && (cached.discoveryExpiresAt === undefined || Date.now() < cached.discoveryExpiresAt)
    ) {
      return cached;
    }
    cached = buildRoutingSnapshot(registry, parent, getAgentCategories(), getAgentRouting());
    return cached;
  };
}

function resolveCategoriesForMenu(
  parent: { providerId: string; model: string },
  parentTier: ModelTier | undefined,
  models: TierCatalogEntry[],
  agentCategories: AgentCategoriesConfig,
  agentRouting: AgentRoutingConfig,
): RoutingSnapshot["resolvedCategories"] {
  const merged = mergeAgentCategoriesWithProvenance(agentCategories);
  const tierContext: TierRoutingContext = {
    parentTier,
    models,
    autoTier: agentRouting.autoTier,
  };
  return Object.entries(merged).map(([name, entry]) => {
    const resolution = resolveSubagentRoute(
      name,
      { providerId: parent.providerId, model: parent.model, thinkingLevel: "medium" },
      agentCategories,
      tierContext,
    );
    const route = "route" in resolution ? resolution.route : undefined;
    return {
      name,
      model: route && route.model !== parent.model ? route.model : "inherit" as const,
      thinkingLevel: entry.config.thinkingLevel,
      tierSource: entry.provenance.tierSource,
    };
  });
}

/** Tier of a model within a snapshot, when known. */
export function snapshotModelTier(snapshot: RoutingSnapshot, modelId: string): ModelTier | undefined {
  return snapshot.models.find((model) => model.id === modelId)?.tier;
}

// ---------------------------------------------------------------------------
// Routable model index (design v3.6): every model id reachable via
// provider:model across runnable providers. Powers (a) the user-named-model
// reminder — the user's words resolve against a closed catalog, so the harness
// hands the main agent exact ids instead of letting it retype from priors —
// and (b) near-match correction at dispatch time.

export interface RoutableModelEntry {
  /** Routable provider id — what goes before the colon in provider:model. */
  providerId: string;
  id: string;
  name: string;
}

export type RoutableModelIndex = () => RoutableModelEntry[];

/** Revision-cached index over all runnable providers' catalogs. */
export function createRoutableModelIndex(registry: ProviderRegistry): RoutableModelIndex {
  let cachedRevision = -1;
  let cached: RoutableModelEntry[] = [];
  return () => {
    const revision = registry.getRoutingRevision();
    if (revision === cachedRevision) return cached;
    const entries: RoutableModelEntry[] = [];
    for (const provider of registry.getEnabled()) {
      const effectiveProviderId = provider.id === "openai" && provider.authType === "oauth"
        ? "openai-codex"
        : provider.id;
      const seen = new Set<string>();
      const push = (id: string, name: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        entries.push({ providerId: provider.id, id, name });
      };
      for (const model of filterProviderModels(
        provider.id,
        registry.getModelConfig().getCustomModels(provider.id),
      )) push(model.id, model.name);
      for (const model of listDynamicModelMetadata(effectiveProviderId)) push(model.id, model.name);
      for (const model of listBuiltinModels(effectiveProviderId)) push(model.id, model.name);
    }
    cachedRevision = revision;
    cached = entries;
    return cached;
  };
}

/** Loose normalization for model-name matching: case/punctuation-insensitive. */
export function normalizeModelToken(value: string): string {
  return value.toLowerCase().replace(/[-._\s]/g, "");
}

/**
 * Near-match candidates for a (probably mistyped) model id within one
 * provider's catalog. "suggest" matches normalized prefixes in either
 * direction (soft "did you mean" notes). "truncation" matches only inputs
 * the catalog EXTENDS ("gpt-5.6" -> gpt-5.6-sol/-terra/-luna) — the one
 * direction that is typo evidence. An input extending a catalog id
 * (gpt-5.6-sol-20260701 vs cataloged gpt-5.6-sol) is more likely a newly
 * released variant the local catalog lags on, and must not be treated as a
 * typo by hard-reject paths. Capped, deterministic order.
 */
export function nearModelMatches(
  input: string,
  candidates: RoutableModelEntry[],
  options: { limit?: number; mode?: "suggest" | "truncation" } = {},
): string[] {
  const limit = options.limit ?? 5;
  const mode = options.mode ?? "suggest";
  const normalized = normalizeModelToken(input);
  if (normalized.length < 3) return [];
  return candidates
    .filter((candidate) => {
      const other = normalizeModelToken(candidate.id);
      if (other === normalized) return false;
      if (other.startsWith(normalized)) return true;
      return mode === "suggest" && normalized.startsWith(other);
    })
    .map((candidate) => candidate.id)
    .sort()
    .slice(0, limit);
}

export { selectTierCandidates };

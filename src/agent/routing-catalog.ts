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
  /** Catalog-effective provider id (openai OAuth -> "openai-codex" alias). */
  effectiveProviderId: string;
  membershipSource: RoutingMembershipSource;
  /** Model list for the PARENT provider only (§1.2 scope note). */
  models: RoutingModelEntry[];
  /** True iff membershipSource === "custom-allowlist" — the only catalog
   *  that hard-rejects unknown ids (§1.4). */
  authoritative: boolean;
  registryRevision: number;
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

  const builtins = listBuiltinModels(effectiveProviderId);
  const builtinIndex = new Map(builtins.map((model, index) => [model.id, index]));
  const dynamic = listDynamicModelMetadata(effectiveProviderId);
  const custom = registry.getModelConfig().getCustomModels(parent.providerId);
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

  return {
    parent: { ...parent, tier: parentTier },
    effectiveProviderId,
    membershipSource,
    models,
    authoritative: membershipSource === "custom-allowlist",
    registryRevision: registry.getRoutingRevision(),
    runnableProviderIds,
    resolvedCategories: resolveCategoriesForMenu(
      parent,
      parentTier,
      models,
      agentCategories,
      agentRouting,
    ),
  };
}

/** Tier-resolution context derived from a snapshot (consumed by categories §3.2). */
export function tierContextFromSnapshot(
  snapshot: RoutingSnapshot,
  agentRouting: AgentRoutingConfig,
): TierRoutingContext {
  return {
    parentTier: snapshot.parent.tier,
    models: snapshot.models.map((model): TierCatalogEntry => ({
      id: model.id,
      tier: model.tier,
      routingPriority: model.routingPriority,
      builtinIndex: model.builtinIndex,
    })),
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
  models: RoutingModelEntry[],
  agentCategories: AgentCategoriesConfig,
  agentRouting: AgentRoutingConfig,
): RoutingSnapshot["resolvedCategories"] {
  const merged = mergeAgentCategoriesWithProvenance(agentCategories);
  const tierContext: TierRoutingContext = {
    parentTier,
    models: models.map((model): TierCatalogEntry => ({
      id: model.id,
      tier: model.tier,
      routingPriority: model.routingPriority,
      builtinIndex: model.builtinIndex,
    })),
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
      for (const model of registry.getModelConfig().getCustomModels(provider.id)) push(model.id, model.name);
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
 * provider's catalog: normalized prefix in either direction — catches
 * truncations like "gpt-5.6" -> gpt-5.6-sol/-terra/-luna without ever
 * matching a genuinely novel id. Capped, deterministic order.
 */
export function nearModelMatches(input: string, candidates: RoutableModelEntry[], limit = 5): string[] {
  const normalized = normalizeModelToken(input);
  if (normalized.length < 3) return [];
  return candidates
    .filter((candidate) => {
      const other = normalizeModelToken(candidate.id);
      return other !== normalized && (other.startsWith(normalized) || normalized.startsWith(other));
    })
    .map((candidate) => candidate.id)
    .sort()
    .slice(0, limit);
}

export { selectTierCandidates };

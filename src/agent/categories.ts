import type { ModelTier } from "../model-catalog.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../types.js";

export interface AgentCategoryConfig {
  model?: string;
  /**
   * Resolve the model by tier within the parent provider's catalog
   * (docs/model-routing-design.md §3.1). Mutually exclusive with `model`;
   * `model` wins if both are set.
   */
  tier?: ModelTier | "inherit";
  thinkingLevel?: ThinkingLevel;
  maxConcurrent?: number;
}

export type AgentCategoriesConfig = Record<string, AgentCategoryConfig>;

/**
 * Field-level provenance for the model-determining fields (§3.3): a value is
 * "user" ONLY when the user's config object literally contained that key.
 * thinkingLevel/maxConcurrent overrides carry no routing authority, so a
 * partially-overridden builtin category keeps its builtin tier under the
 * rank guard.
 */
export interface AgentCategoryProvenance {
  tierSource?: "builtin" | "user";
  modelSource?: "builtin" | "user";
}

export interface MergedAgentCategory {
  config: AgentCategoryConfig;
  provenance: AgentCategoryProvenance;
}

export interface ModelRoute {
  providerId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

/** Which precedence layer decided the model at the category level. */
export type CategoryModelSource = "builtin-tier" | "user-category";

/** Which precedence layer decided the FINAL model (§3.4, chain-tracked). */
export type RouteModelSource = "inherit" | CategoryModelSource | "profile" | "callsite";

export interface ResolvedSubagentRoute extends ModelRoute {
  category?: string;
  inherited: boolean;
  /** Set when the category layer decided the model (undefined = inherit). */
  categoryModelSource?: CategoryModelSource;
  /** True iff providerId+model equal the parent's — regardless of effort (§3.4). */
  modelInherited?: boolean;
  /** Assigned while applying the precedence chain, never inferred from final values. */
  modelSource?: RouteModelSource;
}

export type CategoryResolution =
  | { route: ResolvedSubagentRoute }
  | { error: string };

export interface ResolvedModelSelection {
  providerId: string;
  model: string | "inherit";
}

/** Catalog entry visible to tier resolution (built by routing-catalog.ts). */
export interface TierCatalogEntry {
  id: string;
  tier?: ModelTier;
  /** models.json user-authored ordering; wins over everything (§3.2). */
  routingPriority?: number;
  /** Index in the builtin catalog order, when the id is builtin. */
  builtinIndex?: number;
}

/** Context for rank-guarded automatic tier routing (§3.2). */
export interface TierRoutingContext {
  /** Tier of the parent's own model, if annotated. */
  parentTier?: ModelTier;
  /** Same-provider catalog the tier is resolved against. */
  models: TierCatalogEntry[];
  /** agentRouting.autoTier kill switch (default true). */
  autoTier: boolean;
}

export const TIER_RANK: Record<ModelTier, number> = { fast: 0, balanced: 1, strong: 2 };

const BUILTIN_CATEGORIES: AgentCategoriesConfig = {
  quick: { model: "inherit", tier: "fast", thinkingLevel: "low", maxConcurrent: 3 },
  explore: { model: "inherit", tier: "fast", thinkingLevel: "low", maxConcurrent: 3 },
  deep: { model: "inherit", thinkingLevel: "high", maxConcurrent: 2 },
  review: { model: "inherit", thinkingLevel: "high", maxConcurrent: 2 },
  frontend: { model: "inherit", thinkingLevel: "high", maxConcurrent: 1 },
  writing: { model: "inherit", thinkingLevel: "medium", maxConcurrent: 2 },
};

export function builtinAgentCategories(): AgentCategoriesConfig {
  return cloneCategories(BUILTIN_CATEGORIES);
}

export function mergeAgentCategories(userCategories?: AgentCategoriesConfig): AgentCategoriesConfig {
  const merged = builtinAgentCategories();
  for (const [name, config] of Object.entries(sanitizeAgentCategories(userCategories))) {
    merged[name] = {
      ...(merged[name] ?? {}),
      ...config,
    };
  }
  return merged;
}

/**
 * Field-level merge with provenance (§3.3). The merge itself is identical to
 * mergeAgentCategories; provenance records whether the user literally wrote
 * `tier` / `model`, so builtin tiers flowing through a partial override never
 * masquerade as user intent.
 */
export function mergeAgentCategoriesWithProvenance(
  userCategories?: AgentCategoriesConfig,
): Record<string, MergedAgentCategory> {
  const sanitizedUser = sanitizeAgentCategories(userCategories);
  const out: Record<string, MergedAgentCategory> = {};
  for (const [name, config] of Object.entries(builtinAgentCategories())) {
    out[name] = {
      config: { ...config },
      provenance: {
        tierSource: config.tier !== undefined ? "builtin" : undefined,
        modelSource: config.model !== undefined && config.model !== "inherit" ? "builtin" : undefined,
      },
    };
  }
  for (const [name, config] of Object.entries(sanitizedUser)) {
    const existing = out[name] ?? { config: {}, provenance: {} };
    out[name] = {
      config: { ...existing.config, ...config },
      provenance: {
        tierSource: config.tier !== undefined ? "user" : existing.provenance.tierSource,
        modelSource: config.model !== undefined ? "user" : existing.provenance.modelSource,
      },
    };
  }
  return out;
}

export function sanitizeAgentCategories(value: unknown): AgentCategoriesConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AgentCategoriesConfig = {};
  for (const [name, raw] of Object.entries(value)) {
    const normalizedName = normalizeCategoryName(name);
    if (!normalizedName || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const config: AgentCategoryConfig = {};
    if (typeof record.model === "string" && record.model.trim()) {
      config.model = record.model.trim();
    }
    if (isCategoryTier(record.tier)) {
      config.tier = record.tier;
    }
    if (isThinkingLevel(record.thinkingLevel)) {
      config.thinkingLevel = record.thinkingLevel;
    }
    if (typeof record.maxConcurrent === "number" && Number.isFinite(record.maxConcurrent)) {
      config.maxConcurrent = Math.max(1, Math.floor(record.maxConcurrent));
    }
    out[normalizedName] = config;
  }
  return out;
}

export function resolveSubagentRoute(
  category: string | undefined,
  parent: ModelRoute,
  categories?: AgentCategoriesConfig,
  tierContext?: TierRoutingContext,
): CategoryResolution {
  const normalizedCategory = normalizeCategoryName(category);
  if (!normalizedCategory) {
    return { route: { ...parent, inherited: true } };
  }

  const merged = mergeAgentCategoriesWithProvenance(categories);
  const entry = merged[normalizedCategory];
  if (!entry) {
    return { error: `Unknown subagent category "${normalizedCategory}".` };
  }
  const { config, provenance } = entry;

  // Explicit model binding wins over tier (config surface contract §3.1).
  const modelSelection = parseModelSelection(config.model, parent.providerId);
  if (modelSelection.model !== "inherit") {
    return {
      route: {
        category: normalizedCategory,
        providerId: modelSelection.providerId,
        model: modelSelection.model,
        thinkingLevel: config.thinkingLevel ?? parent.thinkingLevel,
        inherited: false,
        categoryModelSource: provenance.modelSource === "user" ? "user-category" : "builtin-tier",
      },
    };
  }

  // Tier binding: rank-guarded for builtin-sourced tiers, free for
  // user-authored ones (§3.2).
  const tierModel = resolveTierModel(config.tier, provenance.tierSource, tierContext);
  if (tierModel) {
    return {
      route: {
        category: normalizedCategory,
        providerId: parent.providerId,
        model: tierModel,
        thinkingLevel: config.thinkingLevel ?? parent.thinkingLevel,
        inherited: false,
        categoryModelSource: provenance.tierSource === "user" ? "user-category" : "builtin-tier",
      },
    };
  }

  return {
    route: {
      category: normalizedCategory,
      providerId: parent.providerId,
      model: parent.model,
      thinkingLevel: config.thinkingLevel ?? parent.thinkingLevel,
      inherited: config.thinkingLevel === undefined,
    },
  };
}

/**
 * Rank-guarded tier -> model resolution (§3.2). Returns undefined whenever
 * the route must inherit: no tier context wired, kill switch off (builtin
 * tiers only), unknown parent tier, missing target tier, or a target that is
 * not strictly cheaper than the parent.
 */
function resolveTierModel(
  tier: AgentCategoryConfig["tier"],
  tierSource: AgentCategoryProvenance["tierSource"],
  tierContext?: TierRoutingContext,
): string | undefined {
  if (!tier || tier === "inherit" || !tierContext) return undefined;

  const candidates = selectTierCandidates(tierContext.models, tier);
  if (candidates.length === 0) return undefined;

  if (tierSource !== "user") {
    // Builtin-sourced tier: downgrade-only, enforced by rank comparison.
    if (!tierContext.autoTier) return undefined;
    if (!tierContext.parentTier) return undefined;
    if (TIER_RANK[tier] >= TIER_RANK[tierContext.parentTier]) return undefined;
  }

  return candidates[0].id;
}

/**
 * Deterministic within-tier ordering (§3.2): user routingPriority, then
 * builtin catalog order, then normalized id — never a remote response's
 * array order.
 */
export function selectTierCandidates(models: TierCatalogEntry[], tier: ModelTier): TierCatalogEntry[] {
  return models
    .filter((entry) => entry.tier === tier)
    .sort((a, b) => {
      const priorityA = a.routingPriority ?? Number.POSITIVE_INFINITY;
      const priorityB = b.routingPriority ?? Number.POSITIVE_INFINITY;
      if (priorityA !== priorityB) return priorityA - priorityB;
      const builtinA = a.builtinIndex ?? Number.POSITIVE_INFINITY;
      const builtinB = b.builtinIndex ?? Number.POSITIVE_INFINITY;
      if (builtinA !== builtinB) return builtinA - builtinB;
      return a.id.localeCompare(b.id);
    });
}

export function resolveModelRoute(
  model: string | undefined,
  parentProviderId: string,
): ResolvedModelSelection {
  return parseModelSelection(model, parentProviderId);
}

export function resolveSameProviderModelRoute(
  model: string | undefined,
  parentProviderId: string,
): { model: string | "inherit" } {
  return { model: parseModelSelection(model, parentProviderId).model };
}

export function normalizeCategoryName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/** Parses a call-site effort/thinking override, returning undefined when invalid. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

function parseModelSelection(model: string | undefined, parentProviderId: string): ResolvedModelSelection {
  if (!model || model === "inherit") return { providerId: parentProviderId, model: "inherit" };
  if (model.includes(":")) {
    const [providerId, ...rest] = model.split(":");
    return { providerId: providerId || parentProviderId, model: rest.join(":") };
  }
  return { providerId: parentProviderId, model };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function isCategoryTier(value: unknown): value is ModelTier | "inherit" {
  return value === "fast" || value === "balanced" || value === "strong" || value === "inherit";
}

function cloneCategories(categories: AgentCategoriesConfig): AgentCategoriesConfig {
  return Object.fromEntries(
    Object.entries(categories).map(([name, config]) => [name, { ...config }]),
  );
}

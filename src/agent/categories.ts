import type { ThinkingLevel } from "../types.js";

export interface AgentCategoryConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxConcurrent?: number;
}

export type AgentCategoriesConfig = Record<string, AgentCategoryConfig>;

export interface ModelRoute {
  providerId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface ResolvedSubagentRoute extends ModelRoute {
  category?: string;
  inherited: boolean;
}

export type CategoryResolution =
  | { route: ResolvedSubagentRoute }
  | { error: string };

export interface ResolvedModelSelection {
  providerId: string;
  model: string | "inherit";
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const BUILTIN_CATEGORIES: AgentCategoriesConfig = {
  quick: { model: "inherit", thinkingLevel: "low", maxConcurrent: 3 },
  deep: { model: "inherit", thinkingLevel: "high", maxConcurrent: 2 },
  explore: { model: "inherit", thinkingLevel: "low", maxConcurrent: 3 },
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
): CategoryResolution {
  const normalizedCategory = normalizeCategoryName(category);
  if (!normalizedCategory) {
    return { route: { ...parent, inherited: true } };
  }

  const merged = mergeAgentCategories(categories);
  const config = merged[normalizedCategory];
  if (!config) {
    return { error: `Unknown subagent category "${normalizedCategory}".` };
  }

  const modelSelection = parseModelSelection(config.model, parent.providerId);

  return {
    route: {
      category: normalizedCategory,
      providerId: modelSelection.providerId,
      model: modelSelection.model === "inherit" ? parent.model : modelSelection.model,
      thinkingLevel: config.thinkingLevel ?? parent.thinkingLevel,
      inherited: modelSelection.model === "inherit" && config.thinkingLevel === undefined,
    },
  };
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
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

function cloneCategories(categories: AgentCategoriesConfig): AgentCategoriesConfig {
  return Object.fromEntries(
    Object.entries(categories).map(([name, config]) => [name, { ...config }]),
  );
}

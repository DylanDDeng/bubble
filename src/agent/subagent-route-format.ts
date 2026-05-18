import type { ThinkingLevel } from "../types.js";

export interface SubagentRouteLike {
  providerId?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
}

export function formatSubagentRoute(
  route: SubagentRouteLike | undefined,
  options: { includeThinking?: boolean } = {},
): string | undefined {
  if (!route || typeof route !== "object") return undefined;

  const providerId = stringField(route.providerId);
  const model = stringField(route.model);
  if (!providerId && !model) return undefined;

  const modelLabel = providerId && model
    ? `${providerId}:${model}`
    : providerId || model;
  if (!options.includeThinking) return modelLabel;

  const thinkingLevel = stringField(route.thinkingLevel) as ThinkingLevel | undefined;
  return thinkingLevel ? `${modelLabel} (thinking: ${thinkingLevel})` : modelLabel;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

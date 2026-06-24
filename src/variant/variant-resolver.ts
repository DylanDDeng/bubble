import type { ThinkingLevel } from "../types.js";
import { getBuiltinModel, getModelDefaultReasoningLevel } from "../model-catalog.js";
import { clampThinkingLevel } from "./thinking-level.js";

export function getAvailableThinkingLevels(providerId: string, modelId: string): ThinkingLevel[] {
  return getBuiltinModel(providerId, modelId)?.reasoningLevels ?? ["off"];
}

export function getDefaultThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
  const levels = getAvailableThinkingLevels(providerId, modelId);
  const explicitDefault = getModelDefaultReasoningLevel(providerId, modelId);
  if (explicitDefault && levels.includes(explicitDefault)) return explicitDefault;
  return levels.includes("medium") ? "medium" : levels[0] || "off";
}

export function normalizeThinkingLevel(
  level: ThinkingLevel,
  supportedLevels: readonly ThinkingLevel[],
): ThinkingLevel {
  return clampThinkingLevel(level, supportedLevels);
}

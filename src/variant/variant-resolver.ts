import type { ThinkingLevel } from "../types.js";
import { getBuiltinModel } from "../model-catalog.js";
import { clampThinkingLevel } from "./thinking-level.js";

export function getAvailableThinkingLevels(providerId: string, modelId: string): ThinkingLevel[] {
  return getBuiltinModel(providerId, modelId)?.reasoningLevels ?? ["off"];
}

export function getDefaultThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
  const levels = getAvailableThinkingLevels(providerId, modelId);
  return levels.includes("medium") ? "medium" : levels[0] || "off";
}

export function normalizeThinkingLevel(
  level: ThinkingLevel,
  supportedLevels: readonly ThinkingLevel[],
): ThinkingLevel {
  return clampThinkingLevel(level, supportedLevels);
}

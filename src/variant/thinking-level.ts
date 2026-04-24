import type { ThinkingLevel } from "../types.js";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return !!value && THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function clampThinkingLevel(
  requestedLevel: ThinkingLevel,
  supportedLevels: readonly ThinkingLevel[],
): ThinkingLevel {
  if (supportedLevels.length === 0) {
    return "off";
  }

  if (supportedLevels.includes(requestedLevel)) {
    return requestedLevel;
  }

  const requestedIndex = THINKING_LEVELS.indexOf(requestedLevel);
  for (let index = requestedIndex; index >= 0; index--) {
    const candidate = THINKING_LEVELS[index];
    if (supportedLevels.includes(candidate)) {
      return candidate;
    }
  }

  return supportedLevels[0];
}

export function getNextThinkingLevel(
  currentLevel: ThinkingLevel,
  supportedLevels: readonly ThinkingLevel[],
): ThinkingLevel {
  const normalizedCurrent = clampThinkingLevel(currentLevel, supportedLevels);
  const currentIndex = supportedLevels.indexOf(normalizedCurrent);
  return supportedLevels[(currentIndex + 1) % supportedLevels.length];
}

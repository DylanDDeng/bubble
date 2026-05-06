import { homedir } from "node:os";
import { join } from "node:path";

export type BubbleEnvironment = "production" | "dev" | "custom";

export interface BubbleHomeInfo {
  home: string;
  environment: BubbleEnvironment;
}

export function getBubbleHome(): string {
  return getBubbleHomeInfo().home;
}

export function getBubbleHomeInfo(): BubbleHomeInfo {
  const explicitHome = process.env.BUBBLE_HOME?.trim();
  if (explicitHome) {
    return { home: explicitHome, environment: "custom" };
  }
  if (isBubbleDevMode()) {
    return { home: join(homedir(), ".bubble-dev"), environment: "dev" };
  }
  return { home: join(homedir(), ".bubble"), environment: "production" };
}

export function isBubbleDevMode(): boolean {
  const value = process.env.BUBBLE_DEV?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

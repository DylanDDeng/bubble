/**
 * Public types for the Feishu host.
 */

import type { PermissionMode } from "../types.js";

export interface FeishuConfig {
  version: 1;
  app: {
    appId: string;
    secretRef: SecretRef;
    ownerOpenId: string;
    encryptCheck: string;
  };
  preferences: {
    outputThrottleMs: number;
    idleTimeoutMinutes: number;
    renderMode: "card" | "markdown" | "text";
    requireMentionInGroup: boolean;
    maxBytesPerElement: number;
    maxBytesPerCard: number;
  };
  globalLimits: {
    maxConcurrentRuns: number;
  };
}

export type SecretRef =
  | { source: "keystore"; name: string }
  | { source: "env"; varName: string };

export interface ScopesFile {
  version: 1;
  scopes: Record<string, ScopeConfig>;
}

export interface ScopeConfig {
  /** Initial cwd used the first time this scope sees traffic. */
  cwd: string;
  displayName: string;
  allowedUsers: string[];
  admins: string[];
  defaultPermissionMode: PermissionMode;
  model: string | null;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionsFile {
  version: 1;
  sessions: Record<string, SessionEntry>;
}

/** Keyed by `<chatId>:<userId>` in sessions.json. */
export interface SessionEntry {
  sessionFile: string;
  cwd: string;
  permissionMode: PermissionMode;
  lastActiveAt: number;
}

export interface ProcessRegistryFile {
  version: 1;
  processes: ProcessRegistryEntry[];
}

export interface ProcessRegistryEntry {
  pid: number;
  appId: string;
  startedAt: number;
  cwd: string;
}

export const DEFAULT_PREFERENCES: FeishuConfig["preferences"] = {
  outputThrottleMs: 400,
  idleTimeoutMinutes: 15,
  renderMode: "card",
  requireMentionInGroup: true,
  maxBytesPerElement: 28000,
  maxBytesPerCard: 140000,
};

export const DEFAULT_GLOBAL_LIMITS: FeishuConfig["globalLimits"] = {
  maxConcurrentRuns: 5,
};

export type ScopeKey = string;

export function makeScopeKey(chatId: string, userId: string): ScopeKey {
  return `${chatId}:${userId}`;
}

export function parseScopeKey(key: ScopeKey): { chatId: string; userId: string } | undefined {
  const idx = key.indexOf(":");
  if (idx <= 0) return undefined;
  return { chatId: key.slice(0, idx), userId: key.slice(idx + 1) };
}

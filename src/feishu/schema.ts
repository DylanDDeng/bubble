/**
 * Hand-rolled schema validation for Feishu config / scopes / sessions JSON.
 *
 * We avoid zod to keep dependency footprint flat. Each validator returns
 * an array of human-readable errors; empty array means valid.
 */

import type { FeishuConfig, ScopesFile, ScopeConfig, SessionsFile, SessionEntry } from "./types.js";
import { DEFAULT_PREFERENCES, DEFAULT_GLOBAL_LIMITS } from "./types.js";

const PERMISSION_MODES = ["default", "plan", "bypassPermissions"] as const;
const RENDER_MODES = ["card", "markdown", "text"] as const;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function validateFeishuConfig(raw: unknown): ValidationResult<FeishuConfig> {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ["config must be an object"] };
  }
  if (raw.version !== 1) errors.push(`config.version must be 1 (got ${String(raw.version)})`);

  const app = raw.app;
  if (!isObject(app)) {
    errors.push("config.app must be an object");
    return { ok: false, errors };
  }
  if (!isString(app.appId) || !app.appId.trim()) errors.push("config.app.appId must be a non-empty string");
  if (!isString(app.ownerOpenId) || !app.ownerOpenId.trim()) errors.push("config.app.ownerOpenId must be a non-empty string");
  if (!isString(app.encryptCheck)) errors.push("config.app.encryptCheck must be a string");

  const secretRef = app.secretRef;
  if (!isObject(secretRef) || !isString(secretRef.source)) {
    errors.push("config.app.secretRef must be { source: 'keystore'|'env', ... }");
  } else if (secretRef.source === "keystore") {
    if (!isString(secretRef.name) || !secretRef.name) {
      errors.push("config.app.secretRef.name required when source=keystore");
    }
  } else if (secretRef.source === "env") {
    if (!isString(secretRef.varName) || !secretRef.varName) {
      errors.push("config.app.secretRef.varName required when source=env");
    }
  } else {
    errors.push(`config.app.secretRef.source must be 'keystore' or 'env'`);
  }

  // Preferences: fill defaults for missing fields, validate provided ones.
  const prefsRaw = isObject(raw.preferences) ? raw.preferences : {};
  const preferences: FeishuConfig["preferences"] = { ...DEFAULT_PREFERENCES };
  if (prefsRaw.outputThrottleMs !== undefined) {
    if (!isNumber(prefsRaw.outputThrottleMs) || prefsRaw.outputThrottleMs < 50) {
      errors.push("preferences.outputThrottleMs must be a number >= 50");
    } else {
      preferences.outputThrottleMs = prefsRaw.outputThrottleMs;
    }
  }
  if (prefsRaw.idleTimeoutMinutes !== undefined) {
    if (!isNumber(prefsRaw.idleTimeoutMinutes) || prefsRaw.idleTimeoutMinutes < 1) {
      errors.push("preferences.idleTimeoutMinutes must be a number >= 1");
    } else {
      preferences.idleTimeoutMinutes = prefsRaw.idleTimeoutMinutes;
    }
  }
  if (prefsRaw.renderMode !== undefined) {
    if (!isString(prefsRaw.renderMode) || !(RENDER_MODES as readonly string[]).includes(prefsRaw.renderMode)) {
      errors.push(`preferences.renderMode must be one of ${RENDER_MODES.join("|")}`);
    } else {
      preferences.renderMode = prefsRaw.renderMode as FeishuConfig["preferences"]["renderMode"];
    }
  }
  if (prefsRaw.requireMentionInGroup !== undefined) {
    if (!isBoolean(prefsRaw.requireMentionInGroup)) {
      errors.push("preferences.requireMentionInGroup must be boolean");
    } else {
      preferences.requireMentionInGroup = prefsRaw.requireMentionInGroup;
    }
  }
  if (prefsRaw.maxBytesPerElement !== undefined) {
    if (!isNumber(prefsRaw.maxBytesPerElement) || prefsRaw.maxBytesPerElement < 1000) {
      errors.push("preferences.maxBytesPerElement must be a number >= 1000");
    } else {
      preferences.maxBytesPerElement = prefsRaw.maxBytesPerElement;
    }
  }
  if (prefsRaw.maxBytesPerCard !== undefined) {
    if (!isNumber(prefsRaw.maxBytesPerCard) || prefsRaw.maxBytesPerCard < preferences.maxBytesPerElement) {
      errors.push("preferences.maxBytesPerCard must be a number >= maxBytesPerElement");
    } else {
      preferences.maxBytesPerCard = prefsRaw.maxBytesPerCard;
    }
  }

  const limitsRaw = isObject(raw.globalLimits) ? raw.globalLimits : {};
  const globalLimits: FeishuConfig["globalLimits"] = { ...DEFAULT_GLOBAL_LIMITS };
  if (limitsRaw.maxConcurrentRuns !== undefined) {
    if (!isNumber(limitsRaw.maxConcurrentRuns) || limitsRaw.maxConcurrentRuns < 1) {
      errors.push("globalLimits.maxConcurrentRuns must be a number >= 1");
    } else {
      globalLimits.maxConcurrentRuns = limitsRaw.maxConcurrentRuns;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const config: FeishuConfig = {
    version: 1,
    app: {
      appId: (app.appId as string).trim(),
      ownerOpenId: (app.ownerOpenId as string).trim(),
      encryptCheck: app.encryptCheck as string,
      secretRef: secretRef as FeishuConfig["app"]["secretRef"],
    },
    preferences,
    globalLimits,
  };
  return { ok: true, value: config, errors: [] };
}

export function validateScopesFile(raw: unknown): ValidationResult<ScopesFile> {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ["scopes file must be an object"] };
  }
  if (raw.version !== 1) errors.push(`scopes.version must be 1 (got ${String(raw.version)})`);
  const scopes = raw.scopes;
  if (!isObject(scopes)) {
    errors.push("scopes.scopes must be an object");
    return { ok: false, errors };
  }
  const out: Record<string, ScopeConfig> = {};
  for (const [chatId, value] of Object.entries(scopes)) {
    const { ok, value: scope, errors: scopeErrs } = validateScopeConfig(value);
    if (!ok || !scope) {
      for (const e of scopeErrs) errors.push(`scopes[${chatId}]: ${e}`);
      continue;
    }
    out[chatId] = scope;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { version: 1, scopes: out }, errors: [] };
}

export function validateScopeConfig(raw: unknown): ValidationResult<ScopeConfig> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["scope must be an object"] };

  if (!isString(raw.cwd) || !raw.cwd.trim()) errors.push("cwd required");
  if (!isString(raw.displayName) || !raw.displayName.trim()) errors.push("displayName required");
  if (!isStringArray(raw.allowedUsers)) errors.push("allowedUsers must be string[]");
  else if ((raw.allowedUsers as string[]).length === 0) errors.push("allowedUsers must be non-empty");
  if (!isStringArray(raw.admins)) errors.push("admins must be string[]");
  if (!isString(raw.defaultPermissionMode) || !(PERMISSION_MODES as readonly string[]).includes(raw.defaultPermissionMode)) {
    errors.push(`defaultPermissionMode must be one of ${PERMISSION_MODES.join("|")}`);
  }
  if (raw.model !== null && !isString(raw.model)) errors.push("model must be string|null");
  if (!isNumber(raw.createdAt)) errors.push("createdAt must be number");
  if (!isNumber(raw.lastActiveAt)) errors.push("lastActiveAt must be number");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      cwd: (raw.cwd as string).trim(),
      displayName: (raw.displayName as string).trim(),
      allowedUsers: raw.allowedUsers as string[],
      admins: raw.admins as string[],
      defaultPermissionMode: raw.defaultPermissionMode as ScopeConfig["defaultPermissionMode"],
      model: raw.model as string | null,
      createdAt: raw.createdAt as number,
      lastActiveAt: raw.lastActiveAt as number,
    },
    errors: [],
  };
}

export function validateSessionsFile(raw: unknown): ValidationResult<SessionsFile> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["sessions file must be an object"] };
  if (raw.version !== 1) errors.push(`sessions.version must be 1 (got ${String(raw.version)})`);
  const sessions = raw.sessions;
  if (!isObject(sessions)) {
    errors.push("sessions.sessions must be an object");
    return { ok: false, errors };
  }
  const out: Record<string, SessionEntry> = {};
  for (const [key, value] of Object.entries(sessions)) {
    const { ok, value: entry, errors: entryErrs } = validateSessionEntry(value);
    if (!ok || !entry) {
      for (const e of entryErrs) errors.push(`sessions[${key}]: ${e}`);
      continue;
    }
    out[key] = entry;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { version: 1, sessions: out }, errors: [] };
}

export function validateSessionEntry(raw: unknown): ValidationResult<SessionEntry> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["session entry must be an object"] };
  if (!isString(raw.sessionFile) || !raw.sessionFile) errors.push("sessionFile required");
  if (!isString(raw.cwd) || !raw.cwd) errors.push("cwd required");
  if (!isString(raw.permissionMode) || !(PERMISSION_MODES as readonly string[]).includes(raw.permissionMode)) {
    errors.push(`permissionMode must be one of ${PERMISSION_MODES.join("|")}`);
  }
  if (!isNumber(raw.lastActiveAt)) errors.push("lastActiveAt must be number");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      sessionFile: raw.sessionFile as string,
      cwd: raw.cwd as string,
      permissionMode: raw.permissionMode as SessionEntry["permissionMode"],
      lastActiveAt: raw.lastActiveAt as number,
    },
    errors: [],
  };
}

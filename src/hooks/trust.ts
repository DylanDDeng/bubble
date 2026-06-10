import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import type { HookRuleSource, LoadedHookRule } from "./types.js";

export interface ProjectHookFingerprint {
  projectKey: string;
  cwdRealpath: string;
  fingerprint: string;
  projectSettingsPath: string;
  ruleCount: number;
  files: Array<{ path: string; sha256: string }>;
}

interface TrustedProjectHooks {
  cwdRealpath: string;
  fingerprint: string;
  trustedAt: string;
  projectSettingsPath: string;
  ruleCount: number;
}

interface TrustStore {
  version: 1;
  projects: Record<string, TrustedProjectHooks>;
}

export interface TrustStoreOptions {
  bubbleHome?: string;
}

export function getHookTrustPath(options: TrustStoreOptions = {}): string {
  return join(options.bubbleHome ?? getBubbleHome(), "hooks-trust.json");
}

export function buildProjectHookFingerprint(
  cwd: string,
  projectSettingsPath: string,
  projectRules: LoadedHookRule[],
): ProjectHookFingerprint {
  const cwdRealpath = safeRealpath(cwd);
  const projectKey = sha256(cwdRealpath);
  const files = collectRuleFiles(projectSettingsPath, projectRules);
  const stableRules = projectRules.map((rule) => ({
    id: rule.id,
    events: rule.events,
    matcher: rule.matcher,
    command: rule.command,
    onError: rule.onError,
    include: rule.include,
    exposeToModel: rule.exposeToModel,
    inheritToSubagents: rule.inheritToSubagents,
    priority: rule.priority,
  }));
  const fingerprint = sha256(JSON.stringify({
    cwdRealpath,
    projectSettingsPath: safeRealpath(projectSettingsPath),
    projectSettingsHash: hashFileIfExists(projectSettingsPath),
    rules: stableRules,
    files,
  }));
  return {
    projectKey,
    cwdRealpath,
    fingerprint,
    projectSettingsPath,
    ruleCount: projectRules.length,
    files,
  };
}

export function readHookTrustStore(options: TrustStoreOptions = {}): TrustStore {
  const path = getHookTrustPath(options);
  if (!existsSync(path)) return { version: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.projects !== "object") {
      return { version: 1, projects: {} };
    }
    return parsed as TrustStore;
  } catch {
    return { version: 1, projects: {} };
  }
}

export function writeHookTrustStore(store: TrustStore, options: TrustStoreOptions = {}): void {
  const path = getHookTrustPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

export function isProjectHookFingerprintTrusted(
  fingerprint: ProjectHookFingerprint | undefined,
  options: TrustStoreOptions = {},
): { trusted: boolean; trustedFingerprint?: string } {
  if (!fingerprint) return { trusted: true };
  const store = readHookTrustStore(options);
  const trusted = store.projects[fingerprint.projectKey];
  return {
    trusted: trusted?.fingerprint === fingerprint.fingerprint,
    trustedFingerprint: trusted?.fingerprint,
  };
}

export function trustProjectHooks(
  fingerprint: ProjectHookFingerprint,
  options: TrustStoreOptions = {},
): void {
  const store = readHookTrustStore(options);
  store.projects[fingerprint.projectKey] = {
    cwdRealpath: fingerprint.cwdRealpath,
    fingerprint: fingerprint.fingerprint,
    trustedAt: new Date().toISOString(),
    projectSettingsPath: fingerprint.projectSettingsPath,
    ruleCount: fingerprint.ruleCount,
  };
  writeHookTrustStore(store, options);
}

export function untrustProjectHooks(projectKey: string, options: TrustStoreOptions = {}): boolean {
  const store = readHookTrustStore(options);
  if (!store.projects[projectKey]) return false;
  delete store.projects[projectKey];
  writeHookTrustStore(store, options);
  return true;
}

function collectRuleFiles(
  projectSettingsPath: string,
  projectRules: LoadedHookRule[],
): Array<{ path: string; sha256: string }> {
  const files = new Map<string, string>();
  const settingsHash = hashFileIfExists(projectSettingsPath);
  if (settingsHash) files.set(safeRealpath(projectSettingsPath), settingsHash);

  for (const rule of projectRules) {
    for (const candidate of [rule.command.command, ...(rule.command.args ?? [])]) {
      const path = resolveExistingFile(candidate, rule.source);
      if (!path) continue;
      const hash = hashFileIfExists(path);
      if (hash) files.set(safeRealpath(path), hash);
    }
  }

  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sha]) => ({ path, sha256: sha }));
}

function resolveExistingFile(value: string, source: HookRuleSource): string | undefined {
  if (!value || !looksLikePath(value)) return undefined;
  const path = isAbsolute(value) ? value : resolve(dirname(source.path), value);
  try {
    if (existsSync(path) && statSync(path).isFile()) return path;
  } catch {
    return undefined;
  }
  return undefined;
}

function looksLikePath(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || value.includes("/");
}

function hashFileIfExists(path: string): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    return sha256(readFileSync(path));
  } catch {
    return undefined;
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

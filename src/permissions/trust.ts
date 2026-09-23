import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

/**
 * Trust for the parts of the repository's settings files
 * (`.bubble/settings.json`, `.bubble/settings.local.json`) that grant
 * capabilities: allow rules, MCP servers (which Bubble spawns) and LSP server
 * definitions (custom commands, env such as NODE_OPTIONS).
 *
 * Those files arrive with a clone, so they are someone else's decision until
 * the user reviews them. Like project hooks, they are ignored until trusted,
 * and trust is pinned to their exact content: any change asks again (hosts
 * prompt at startup — trust-prompt.ts for the TUI, the SDK's onProjectTrust
 * for embedders). Deny rules and switches that only turn things off need no
 * trust.
 */

interface TrustStore {
  version: 1;
  projects: Record<string, { fingerprint: string; trustedAt: string }>;
}

export interface PermissionTrustOptions {
  bubbleHome?: string;
}

/** Parsed contents of the two repository settings files (null when absent). */
export interface RepoSettingsRaw {
  project: unknown;
  local: unknown;
}

export interface RepoCapabilities {
  allow: string[];
  mcpServers: string[];
  /** LSP server ids whose definition carries more than an on/off switch. */
  lspServers: string[];
}

export function getPermissionTrustPath(options: PermissionTrustOptions = {}): string {
  return join(options.bubbleHome ?? getBubbleHome(), "permissions-trust.json");
}

export function repoCapabilities(raw: unknown): RepoCapabilities {
  const settings = isRecord(raw) ? raw : {};
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((rule): rule is string => typeof rule === "string")
    : [];
  const mcpServers = isRecord(settings.mcpServers) ? Object.keys(settings.mcpServers) : [];
  const lspServers = isRecord(settings.lsp)
    ? Object.entries(settings.lsp)
      .filter(([, server]) => isRecord(server) && Object.keys(server).some((key) => key !== "disabled"))
      .map(([id]) => id)
    : [];
  return { allow, mcpServers, lspServers };
}

/** Everything the given repository settings would enable, both scopes merged. */
export function mergedRepoCapabilities(raw: RepoSettingsRaw): RepoCapabilities {
  const project = repoCapabilities(raw.project);
  const local = repoCapabilities(raw.local);
  return {
    allow: [...project.allow, ...local.allow],
    mcpServers: [...new Set([...project.mcpServers, ...local.mcpServers])],
    lspServers: [...new Set([...project.lspServers, ...local.lspServers])],
  };
}

export function describeRepoCapabilities(caps: RepoCapabilities): string[] {
  return [
    ...caps.allow.map((rule) => `allow rule   ${rule}`),
    ...caps.mcpServers.map((name) => `MCP server   ${name} (Bubble starts it)`),
    ...caps.lspServers.map((id) => `LSP server   ${id} (custom command, env or options)`),
  ];
}

export function hasRepoCapabilities(raw: RepoSettingsRaw): boolean {
  return [raw.project, raw.local].some((scope) => {
    const caps = repoCapabilities(scope);
    return caps.allow.length + caps.mcpServers.length + caps.lspServers.length > 0;
  });
}

export function repoConfigFingerprint(cwd: string, raw: RepoSettingsRaw): string {
  const pick = (scope: unknown) => {
    const settings = isRecord(scope) ? scope : {};
    const permissions = isRecord(settings.permissions) ? settings.permissions : {};
    return { allow: permissions.allow ?? null, mcpServers: settings.mcpServers ?? null, lsp: settings.lsp ?? null };
  };
  return createHash("sha256")
    .update(JSON.stringify({ cwd: safeRealpath(cwd), project: pick(raw.project), local: pick(raw.local) }))
    .digest("hex");
}

/** True when the repository grants nothing, or the user trusted exactly this content. */
export function isRepoConfigTrusted(
  cwd: string,
  raw: RepoSettingsRaw,
  options: PermissionTrustOptions = {},
): boolean {
  if (!hasRepoCapabilities(raw)) return true;
  return readStore(options).projects[safeRealpath(cwd)]?.fingerprint === repoConfigFingerprint(cwd, raw);
}

export function trustRepoConfig(
  cwd: string,
  raw: RepoSettingsRaw,
  options: PermissionTrustOptions = {},
): void {
  const store = readStore(options);
  store.projects[safeRealpath(cwd)] = {
    fingerprint: repoConfigFingerprint(cwd, raw),
    trustedAt: new Date().toISOString(),
  };
  const path = getPermissionTrustPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/** Reads both repository settings files; unparsable files count as absent. */
export function readRepoSettings(cwd: string): RepoSettingsRaw {
  const read = (path: string): unknown => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  };
  return {
    project: read(join(cwd, ".bubble", "settings.json")),
    local: read(join(cwd, ".bubble", "settings.local.json")),
  };
}

function readStore(options: PermissionTrustOptions): TrustStore {
  const path = getPermissionTrustPath(options);
  if (!existsSync(path)) return { version: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TrustStore>;
    if (parsed && typeof parsed.projects === "object" && parsed.projects !== null) {
      return { version: 1, projects: parsed.projects as TrustStore["projects"] };
    }
  } catch {
    // A corrupt store trusts nothing.
  }
  return { version: 1, projects: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

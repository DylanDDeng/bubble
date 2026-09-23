/**
 * Persistent permission settings.
 *
 * Three scopes, lowest to highest precedence:
 *
 *   user    — ~/.bubble/settings.json            (cross-project preferences)
 *   project — <cwd>/.bubble/settings.json        (team-shared, check into git)
 *   local   — <cwd>/.bubble/settings.local.json  (personal, gitignore)
 *
 * `defaultMode` uses last-wins precedence (local beats project beats user).
 * `allow` / `deny` arrays are concatenated across scopes (with the rule text
 * itself carrying provenance via `PermissionRule.source`).
 *
 * Allow rules and LSP server definitions from the project and local scopes
 * live inside the repository, so they only take effect once the user trusts
 * this folder (asked at startup, see trust.ts); until then they are reported in
 * `untrusted` (MCP servers from those files are gated the same way by
 * loadMcpConfig).
 *
 * Parse errors do not fail the load; they collect into `diagnostics` so callers
 * can surface them in /permissions or on startup without taking the agent down.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import type { PermissionMode } from "../types.js";
import { normalizeLspConfig, type LspConfig } from "../lsp/config.js";
import { parseRules } from "./rule.js";
import { isRepoConfigTrusted, repoCapabilities, trustRepoConfig, type RepoCapabilities } from "./trust.js";
import type { PermissionRule, PermissionRuleSet } from "./types.js";

export type SettingsScope = "user" | "project" | "local";
export type RuleList = "allow" | "deny";

export interface RawSettings {
  lsp?: unknown;
  permissions?: {
    defaultMode?: string;
    allow?: string[];
    deny?: string[];
  };
}

export interface SettingsDiagnostic {
  scope: SettingsScope;
  path: string;
  message: string;
}

export interface MergedSettings {
  defaultMode?: PermissionMode;
  lsp?: LspConfig;
  ruleSet: PermissionRuleSet;
  /** Project/local allow rules ignored until the user trusts them. */
  untrustedAllow: PermissionRule[];
  /** Everything in the repository settings that waits for trust (allow rules, MCP servers, LSP servers). */
  untrusted: RepoCapabilities;
  diagnostics: SettingsDiagnostic[];
}

export interface SettingsManagerOptions {
  /** Override for Bubble home. Respects BUBBLE_HOME/BUBBLE_DEV env vars by default. */
  bubbleHome?: string;
}

const KNOWN_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "default",
  "plan",
  "bypassPermissions",
]);

export class SettingsManager {
  private readonly paths: Record<SettingsScope, string>;
  private raw: Record<SettingsScope, RawSettings | null> = {
    user: null,
    project: null,
    local: null,
  };
  private fileDiagnostics: SettingsDiagnostic[] = [];
  private readonly cwd: string;
  private readonly bubbleHome?: string;
  /** Cached per load: whether the repository's capability settings are trusted. */
  private repoTrusted = false;

  constructor(cwd: string, options: SettingsManagerOptions = {}) {
    const bubbleHome = options.bubbleHome ?? getBubbleHome();
    this.cwd = cwd;
    this.bubbleHome = bubbleHome;

    this.paths = {
      user: join(bubbleHome, "settings.json"),
      project: join(cwd, ".bubble", "settings.json"),
      local: join(cwd, ".bubble", "settings.local.json"),
    };

    this.reload();
  }

  /** Re-read all three files from disk. */
  reload(): void {
    this.fileDiagnostics = [];
    for (const scope of ["user", "project", "local"] as SettingsScope[]) {
      this.raw[scope] = this.readFile(scope);
    }
    this.repoTrusted = isRepoConfigTrusted(this.cwd, this.repoRaw(), { bubbleHome: this.bubbleHome });
  }

  /**
   * Trust the repository's current capability settings (allow rules, MCP
   * servers, LSP servers from the project and local files).
   */
  trustRepoConfig(): void {
    trustRepoConfig(this.cwd, this.repoRaw(), { bubbleHome: this.bubbleHome });
    this.repoTrusted = true;
  }

  private repoRaw(): { project: unknown; local: unknown } {
    return { project: this.raw.project, local: this.raw.local };
  }

  /**
   * Bubble's own /permissions edits keep an existing trust: rules the user
   * adds through Bubble are their decision. An untrusted rule set stays
   * untrusted — editing it must not launder rules the user never reviewed.
   */
  private keepRepoTrustAfterWrite(scope: SettingsScope, wasTrusted: boolean): void {
    if (scope === "user") return;
    if (wasTrusted) this.trustRepoConfig();
    else this.repoTrusted = isRepoConfigTrusted(this.cwd, this.repoRaw(), { bubbleHome: this.bubbleHome });
  }

  getPath(scope: SettingsScope): string {
    return this.paths[scope];
  }

  /** Merged view for runtime consumption. Does not hit disk — call `reload()` first if stale. */
  getMerged(): MergedSettings {
    const diagnostics: SettingsDiagnostic[] = [...this.fileDiagnostics];

    let defaultMode: PermissionMode | undefined;
    let lsp: LspConfig | undefined;
    const allow: PermissionRule[] = [];
    const deny: PermissionRule[] = [];
    const untrustedAllow: PermissionRule[] = [];

    for (const scope of ["user", "project", "local"] as SettingsScope[]) {
      const data = this.raw[scope];
      if (!data) continue;
      if ("lsp" in data) {
        const trustedLsp = scope === "user" || this.repoTrusted;
        const parsed = trustedLsp ? normalizeLspConfig(data.lsp) : untrustedLspSwitches(data.lsp);
        if (!trustedLsp && repoCapabilities(data).lspServers.length > 0) {
          diagnostics.push({
            scope,
            path: this.paths[scope],
            message: `Ignored LSP server definitions from this repository (${repoCapabilities(data).lspServers.join(", ")}): the folder is not trusted (Bubble asks at startup).`,
          });
        }
        if (parsed === undefined) {
          diagnostics.push({
            scope,
            path: this.paths[scope],
            message: "Ignored lsp setting — expected boolean or object.",
          });
        } else if (parsed !== null) {
          lsp = parsed;
        }
      }
      if (!data.permissions) continue;
      const perms = data.permissions;

      if (typeof perms.defaultMode === "string") {
        const rawMode = perms.defaultMode === "acceptEdits" ? "default" : perms.defaultMode;
        if (KNOWN_MODES.has(rawMode as PermissionMode)) {
          defaultMode = rawMode as PermissionMode;
        } else {
          diagnostics.push({
            scope,
            path: this.paths[scope],
            message: `Ignored defaultMode "${perms.defaultMode}" — not one of: ${[...KNOWN_MODES].join(", ")}.`,
          });
        }
      }

      if (Array.isArray(perms.allow)) {
        const parsed = parseRules(perms.allow);
        if (scope === "user" || this.repoTrusted) {
          allow.push(...parsed.rules);
        } else {
          untrustedAllow.push(...parsed.rules);
          if (parsed.rules.length > 0) {
            diagnostics.push({
              scope,
              path: this.paths[scope],
              message: `Ignored ${parsed.rules.length} allow rule${parsed.rules.length === 1 ? "" : "s"} from this repository: the folder is not trusted (Bubble asks at startup).`,
            });
          }
        }
        for (const err of parsed.errors) {
          diagnostics.push({
            scope,
            path: this.paths[scope],
            message: `Invalid allow rule "${err.source.trim()}": ${err.message}`,
          });
        }
      }

      if (Array.isArray(perms.deny)) {
        const parsed = parseRules(perms.deny);
        deny.push(...parsed.rules);
        for (const err of parsed.errors) {
          diagnostics.push({
            scope,
            path: this.paths[scope],
            message: `Invalid deny rule "${err.source.trim()}": ${err.message}`,
          });
        }
      }
    }

    return {
      defaultMode,
      lsp,
      ruleSet: { allow, deny },
      untrustedAllow,
      untrusted: this.repoTrusted
        ? { allow: [], mcpServers: [], lspServers: [] }
        : mergeCapabilities(repoCapabilities(this.raw.project), repoCapabilities(this.raw.local)),
      diagnostics,
    };
  }

  /**
   * Add a rule to the specified list in the specified scope. Creates the file
   * and parent directories if needed. Silently skips if the exact string is
   * already present.
   *
   * Returns true if the file was written.
   */
  addRule(scope: SettingsScope, list: RuleList, rule: string): boolean {
    const raw = this.raw[scope] ?? {};
    const permissions = { ...(raw.permissions ?? {}) };
    const current = Array.isArray(permissions[list]) ? [...permissions[list]!] : [];

    if (current.includes(rule)) {
      return false;
    }
    current.push(rule);
    permissions[list] = current;

    const wasTrusted = this.repoTrusted;
    const next: RawSettings = { ...raw, permissions };
    this.writeFile(scope, next);
    this.raw[scope] = next;
    this.keepRepoTrustAfterWrite(scope, wasTrusted);
    return true;
  }

  /**
   * Remove the first matching rule (by exact string) from the specified list
   * in the specified scope. Returns true if a rule was removed.
   */
  removeRule(scope: SettingsScope, list: RuleList, rule: string): boolean {
    const raw = this.raw[scope];
    if (!raw || !raw.permissions) return false;
    const current = Array.isArray(raw.permissions[list]) ? [...raw.permissions[list]!] : [];
    const index = current.indexOf(rule);
    if (index < 0) return false;
    current.splice(index, 1);

    const nextPermissions = { ...raw.permissions, [list]: current };
    // Drop the key if empty, keep file readable
    if (current.length === 0) delete nextPermissions[list];

    const wasTrusted = this.repoTrusted;
    const next: RawSettings = { ...raw, permissions: nextPermissions };
    this.writeFile(scope, next);
    this.raw[scope] = next;
    this.keepRepoTrustAfterWrite(scope, wasTrusted);
    return true;
  }

  // -- internal --------------------------------------------------------

  private readFile(scope: SettingsScope): RawSettings | null {
    const path = this.paths[scope];
    if (!existsSync(path)) return null;
    try {
      const text = readFileSync(path, "utf-8");
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.fileDiagnostics.push({
          scope,
          path,
          message: "Settings file must contain a JSON object at the top level.",
        });
        return null;
      }
      return parsed as RawSettings;
    } catch (err) {
      this.fileDiagnostics.push({
        scope,
        path,
        message: `Failed to parse settings: ${(err as Error).message}`,
      });
      return null;
    }
  }

  private writeFile(scope: SettingsScope, data: RawSettings): void {
    const path = this.paths[scope];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
}

/**
 * What an untrusted repository may still say about LSP: turning it off, or
 * turning individual servers off. Commands, env and options need trust.
 * Returns null when nothing usable is left (the scope then does not override).
 */
function untrustedLspSwitches(value: unknown): LspConfig | undefined | null {
  if (typeof value === "boolean") return value === false ? false : null;
  const parsed = normalizeLspConfig(value);
  if (parsed === undefined || typeof parsed === "boolean") return parsed;
  const switches = Object.fromEntries(
    Object.entries(parsed)
      .filter(([, server]) => server.disabled === true)
      .map(([id]) => [id, { disabled: true }]),
  );
  return Object.keys(switches).length > 0 ? switches : null;
}

function mergeCapabilities(a: RepoCapabilities, b: RepoCapabilities): RepoCapabilities {
  return {
    allow: [...a.allow, ...b.allow],
    mcpServers: [...new Set([...a.mcpServers, ...b.mcpServers])],
    lspServers: [...new Set([...a.lspServers, ...b.lspServers])],
  };
}

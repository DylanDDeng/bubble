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
 * Parse errors do not fail the load; they collect into `diagnostics` so callers
 * can surface them in /permissions or on startup without taking the agent down.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PermissionMode } from "../types.js";
import { normalizeLspConfig, type LspConfig } from "../lsp/config.js";
import { parseRules } from "./rule.js";
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
  diagnostics: SettingsDiagnostic[];
}

export interface SettingsManagerOptions {
  /** Override for `~/.bubble`. Respects BUBBLE_HOME env var by default. */
  bubbleHome?: string;
}

const KNOWN_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

export class SettingsManager {
  private readonly cwd: string;
  private readonly paths: Record<SettingsScope, string>;
  private raw: Record<SettingsScope, RawSettings | null> = {
    user: null,
    project: null,
    local: null,
  };
  private fileDiagnostics: SettingsDiagnostic[] = [];

  constructor(cwd: string, options: SettingsManagerOptions = {}) {
    this.cwd = cwd;
    const bubbleHome = options.bubbleHome
      ?? process.env.BUBBLE_HOME
      ?? join(homedir(), ".bubble");

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

    for (const scope of ["user", "project", "local"] as SettingsScope[]) {
      const data = this.raw[scope];
      if (!data) continue;
      if ("lsp" in data) {
        const parsed = normalizeLspConfig(data.lsp);
        if (parsed === undefined) {
          diagnostics.push({
            scope,
            path: this.paths[scope],
            message: "Ignored lsp setting — expected boolean or object.",
          });
        } else {
          lsp = parsed;
        }
      }
      if (!data.permissions) continue;
      const perms = data.permissions;

      if (typeof perms.defaultMode === "string") {
        if (KNOWN_MODES.has(perms.defaultMode as PermissionMode)) {
          defaultMode = perms.defaultMode as PermissionMode;
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
        allow.push(...parsed.rules);
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

    const next: RawSettings = { ...raw, permissions };
    this.writeFile(scope, next);
    this.raw[scope] = next;
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

    const next: RawSettings = { ...raw, permissions: nextPermissions };
    this.writeFile(scope, next);
    this.raw[scope] = next;
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

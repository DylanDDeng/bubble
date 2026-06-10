import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import {
  buildProjectHookFingerprint,
  isProjectHookFingerprintTrusted,
  type ProjectHookFingerprint,
  type TrustStoreOptions,
} from "./trust.js";
import {
  type HookDiagnostic,
  type HookEventName,
  type HookFailurePolicy,
  type HookSourceScope,
  type LoadedHookConfig,
  type LoadedHookRule,
  type RawHookRule,
  isHookEventName,
} from "./types.js";

interface RawHooksSettings {
  enabled?: unknown;
  rules?: unknown;
}

interface RawSettingsWithHooks {
  hooks?: unknown;
}

export interface LoadHookConfigOptions extends TrustStoreOptions {
  cwd: string;
}

const SCOPES: readonly HookSourceScope[] = ["user", "project", "local"];
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export function loadHookConfig(options: LoadHookConfigOptions): LoadedHookConfig {
  const bubbleHome = options.bubbleHome ?? getBubbleHome();
  const paths: Record<HookSourceScope, string> = {
    user: join(bubbleHome, "settings.json"),
    project: join(options.cwd, ".bubble", "settings.json"),
    local: join(options.cwd, ".bubble", "settings.local.json"),
  };
  const diagnostics: HookDiagnostic[] = [];
  const rules: LoadedHookRule[] = [];

  for (const scope of SCOPES) {
    const path = paths[scope];
    const loaded = readHooksFile(scope, path);
    diagnostics.push(...loaded.diagnostics);
    if (!loaded.settings) continue;
    const parsed = parseHookSettings(scope, path, loaded.settings);
    diagnostics.push(...parsed.diagnostics);
    rules.push(...parsed.rules);
  }

  const projectRules = rules.filter((rule) => rule.source.scope === "project");
  const fingerprint = projectRules.length > 0
    ? buildProjectHookFingerprint(options.cwd, paths.project, projectRules)
    : undefined;
  const trust = isProjectHookFingerprintTrusted(fingerprint, { bubbleHome });

  for (const rule of rules) {
    if (rule.source.scope !== "project") continue;
    rule.trustRequired = true;
    rule.trusted = trust.trusted;
  }

  return {
    rules: rules.sort(compareRules),
    diagnostics,
    paths,
    projectTrust: {
      required: projectRules.length > 0,
      trusted: trust.trusted,
      projectKey: fingerprint?.projectKey,
      fingerprint: fingerprint?.fingerprint,
      trustedFingerprint: trust.trustedFingerprint,
      reason: projectRules.length === 0
        ? "No project hooks configured."
        : trust.trusted
          ? "Project hooks are trusted for the current fingerprint."
          : "Project hooks are configured but not trusted for the current fingerprint.",
    },
  };
}

export function getProjectHookFingerprint(options: LoadHookConfigOptions): ProjectHookFingerprint | undefined {
  const loaded = loadHookConfig(options);
  if (!loaded.projectTrust.required) return undefined;
  const projectRules = loaded.rules.filter((rule) => rule.source.scope === "project");
  return buildProjectHookFingerprint(options.cwd, loaded.paths.project, projectRules);
}

export function formatHooksStatus(config: LoadedHookConfig): string {
  const lines: string[] = ["Hooks status:"];
  lines.push(`  user:    ${config.paths.user}`);
  lines.push(`  project: ${config.paths.project}`);
  lines.push(`  local:   ${config.paths.local}`);
  if (config.projectTrust.required) {
    lines.push(
      `  project trust: ${config.projectTrust.trusted ? "trusted" : "not trusted"}`
      + (config.projectTrust.fingerprint ? ` (${config.projectTrust.fingerprint.slice(0, 12)})` : ""),
    );
  } else {
    lines.push("  project trust: not required");
  }
  lines.push("", `Rules (${config.rules.length}):`);
  if (config.rules.length === 0) {
    lines.push("  (none)");
  } else {
    for (const rule of config.rules) {
      const state = rule.enabled && rule.trusted ? "enabled" : rule.enabled ? "untrusted" : "disabled";
      const matcher = rule.matcher ? ` matcher=${rule.matcher}` : "";
      lines.push(
        `  ${state} ${rule.id} [${rule.source.scope}] events=${rule.events.join(",")} command=${formatCommand(rule.command.command, rule.command.args)}${matcher}`,
      );
    }
  }
  if (config.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of config.diagnostics) {
      lines.push(`  [${diagnostic.scope}] ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
  return lines.join("\n");
}

export function explainHookEvent(eventName: HookEventName, config: LoadedHookConfig): string {
  const rules = config.rules.filter((rule) => rule.events.includes(eventName));
  const lines = [`Hooks for ${eventName}:`];
  if (rules.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const rule of rules) {
    const reasons: string[] = [];
    if (!rule.enabled) reasons.push("disabled");
    if (!rule.trusted) reasons.push("untrusted");
    if (rule.source.scope === "project" && !rule.trusted) reasons.push("run /hooks trust project");
    const suffix = reasons.length ? ` - ${reasons.join(", ")}` : "";
    lines.push(`  ${rule.id} [${rule.source.scope}] ${formatCommand(rule.command.command, rule.command.args)}${suffix}`);
  }
  return lines.join("\n");
}

function readHooksFile(
  scope: HookSourceScope,
  path: string,
): { settings?: RawHooksSettings; diagnostics: HookDiagnostic[] } {
  if (!existsSync(path)) return { diagnostics: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RawSettingsWithHooks;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { diagnostics: [{ scope, path, message: "Settings file must contain a JSON object." }] };
    }
    if (parsed.hooks === undefined) return { diagnostics: [] };
    if (Array.isArray(parsed.hooks)) return { settings: { rules: parsed.hooks }, diagnostics: [] };
    if (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) {
      return { diagnostics: [{ scope, path, message: "Ignored hooks setting - expected object or array." }] };
    }
    return { settings: parsed.hooks as RawHooksSettings, diagnostics: [] };
  } catch (error) {
    return {
      diagnostics: [{
        scope,
        path,
        message: `Failed to parse hooks settings: ${(error as Error).message}`,
      }],
    };
  }
}

function parseHookSettings(
  scope: HookSourceScope,
  path: string,
  settings: RawHooksSettings,
): { rules: LoadedHookRule[]; diagnostics: HookDiagnostic[] } {
  const diagnostics: HookDiagnostic[] = [];
  const rules: LoadedHookRule[] = [];
  if (settings.enabled === false) return { rules, diagnostics };
  if (!Array.isArray(settings.rules)) {
    diagnostics.push({ scope, path, message: "Ignored hooks.rules - expected array." });
    return { rules, diagnostics };
  }

  settings.rules.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.push({ scope, path, message: `Ignored hook rule at index ${index} - expected object.` });
      return;
    }
    const parsed = parseHookRule(raw as RawHookRule, { scope, path, index });
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    if (parsed.rule) rules.push(parsed.rule);
  });
  return { rules, diagnostics };
}

function parseHookRule(
  raw: RawHookRule,
  source: LoadedHookRule["source"],
): { rule?: LoadedHookRule; diagnostic?: HookDiagnostic } {
  const events = parseEvents(raw.event, raw.events);
  if (events.length === 0) {
    return { diagnostic: diagnostic(source, "Ignored hook rule - event must be a known hook event.") };
  }

  const command = parseCommand(raw, source);
  if (typeof command === "string") {
    return { diagnostic: diagnostic(source, command) };
  }

  const matcher = typeof raw.matcher === "string" && raw.matcher.trim() ? raw.matcher.trim() : undefined;
  if (matcher) {
    try {
      new RegExp(matcher);
    } catch (error) {
      return { diagnostic: diagnostic(source, `Ignored hook rule - invalid matcher regex: ${(error as Error).message}`) };
    }
  }

  const idRaw = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : "";
  const id = idRaw.trim() || `${source.scope}:${source.index}:${events.join("+")}:${command.command}`;
  const onError = parseFailurePolicy(raw.onError ?? raw.failurePolicy);
  const include = parseStringArray(raw.include);
  return {
    rule: {
      id,
      events,
      matcher,
      command,
      timeoutMs: clampNumber(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 50, MAX_TIMEOUT_MS),
      maxOutputBytes: clampNumber(raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES),
      enabled: raw.enabled !== false,
      onError,
      include,
      exposeToModel: raw.exposeToModel === true,
      inheritToSubagents: raw.inheritToSubagents === true,
      priority: clampNumber(raw.priority, 0, -10_000, 10_000),
      source,
      trusted: source.scope !== "project",
      trustRequired: source.scope === "project",
    },
  };
}

function parseEvents(event: unknown, events: unknown): HookEventName[] {
  const values = Array.isArray(events) ? events : event !== undefined ? [event] : [];
  const parsed: HookEventName[] = [];
  for (const value of values) {
    if (isHookEventName(value) && !parsed.includes(value)) parsed.push(value);
  }
  return parsed;
}

function parseCommand(raw: RawHookRule, source: LoadedHookRule["source"]) {
  if (typeof raw.command !== "string" || !raw.command.trim()) {
    return "Ignored hook rule - command must be a non-empty string.";
  }
  if (/[\0\r\n]/.test(raw.command)) {
    return "Ignored hook rule - command must not contain control characters.";
  }
  const command = resolveCommand(raw.command.trim(), source);
  if (source.scope === "project" && !looksLikePath(raw.command.trim())) {
    return "Ignored project hook rule - project hook command must be an absolute or relative executable path.";
  }
  const args = parseStringArray(raw.args);
  const cwd = typeof raw.cwd === "string" && raw.cwd.trim()
    ? resolveAgainstSource(raw.cwd.trim(), source)
    : undefined;
  const env = parseEnv(raw.env);
  return { command, ...(args.length ? { args } : {}), ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) };
}

function resolveCommand(command: string, source: LoadedHookRule["source"]): string {
  return looksLikePath(command) ? resolveAgainstSource(command, source) : command;
}

function resolveAgainstSource(value: string, source: LoadedHookRule["source"]): string {
  return isAbsolute(value) ? value : resolve(dirname(source.path), value);
}

function parseEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string");
  return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function parseFailurePolicy(value: unknown): HookFailurePolicy {
  return value === "block" ? "block" : "allow";
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function diagnostic(source: LoadedHookRule["source"], message: string): HookDiagnostic {
  return { scope: source.scope, path: source.path, message };
}

function looksLikePath(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || value.includes("/");
}

function compareRules(a: LoadedHookRule, b: LoadedHookRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const scopeOrder: Record<HookSourceScope, number> = { user: 0, project: 1, local: 2 };
  if (scopeOrder[a.source.scope] !== scopeOrder[b.source.scope]) {
    return scopeOrder[a.source.scope] - scopeOrder[b.source.scope];
  }
  return a.source.index - b.source.index;
}

function formatCommand(command: string, args?: string[]): string {
  return [command, ...(args ?? [])].join(" ");
}

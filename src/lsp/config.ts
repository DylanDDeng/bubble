export interface LspServerConfig {
  disabled?: boolean;
  command?: string[];
  extensions?: string[];
  rootMarkers?: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  languageId?: string;
}

export type BuiltinLspServerId = "typescript" | "deno" | "vue" | "eslint" | "oxlint";
export type LspServerId = BuiltinLspServerId | string;

export type LspConfig = boolean | Record<string, LspServerConfig>;

export const BUILTIN_LSP_SERVER_IDS: readonly BuiltinLspServerId[] = ["typescript", "deno", "vue", "eslint", "oxlint"];

export function normalizeLspConfig(value: unknown): LspConfig | undefined {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const config: Exclude<LspConfig, boolean> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const server = value as Record<string, unknown>;
    const next: LspServerConfig = {};
    if (typeof server.disabled === "boolean") next.disabled = server.disabled;
    if (isStringArray(server.command) && server.command.length > 0) next.command = server.command;
    if (isStringArray(server.extensions)) next.extensions = server.extensions;
    if (isStringArray(server.rootMarkers)) next.rootMarkers = server.rootMarkers;
    if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
      next.env = Object.fromEntries(
        Object.entries(server.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
    if (server.initializationOptions && typeof server.initializationOptions === "object" && !Array.isArray(server.initializationOptions)) {
      next.initializationOptions = server.initializationOptions as Record<string, unknown>;
    }
    if (typeof server.languageId === "string") next.languageId = server.languageId;
    config[id] = next;
  }
  return config;
}

export function isLspEnabled(config: LspConfig | undefined): boolean {
  return config !== false;
}

export function isLspServerEnabled(config: LspConfig | undefined, id: LspServerId): boolean {
  if (!isLspEnabled(config)) return false;
  if (config && typeof config === "object" && config[id]?.disabled) return false;
  return true;
}

export function isTypeScriptLspEnabled(config: LspConfig | undefined): boolean {
  return isLspServerEnabled(config, "typescript");
}

export function customLspServerEntries(config: LspConfig | undefined): Array<[string, LspServerConfig]> {
  if (!config || typeof config !== "object") return [];
  return Object.entries(config).filter(([id, server]) =>
    !BUILTIN_LSP_SERVER_IDS.includes(id as BuiltinLspServerId)
    && Array.isArray(server.command)
    && server.command.length > 0
    && Array.isArray(server.extensions)
    && server.extensions.length > 0,
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

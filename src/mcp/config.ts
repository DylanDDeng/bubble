/**
 * Load and validate mcpServers from user / project / local settings files.
 *
 * Precedence: later scope wins (user → project → local). Each server is
 * identified by its key in mcpServers; if the same name appears in multiple
 * scopes, the higher-precedence scope overwrites, and we record a diagnostic.
 *
 * Env expansion: ${VAR} in command, args, env values, url, or header values
 * is replaced with the matching process.env entry. Missing vars become empty
 * strings and yield a diagnostic (non-fatal).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig, ScopedMcpServerConfig } from "./types.js";

export interface McpConfigDiagnostic {
  scope: "user" | "project" | "local";
  path: string;
  message: string;
}

export interface LoadedMcpConfig {
  servers: ScopedMcpServerConfig[];
  diagnostics: McpConfigDiagnostic[];
}

export interface LoadMcpConfigOptions {
  cwd: string;
  bubbleHome?: string;
}

export function loadMcpConfig(options: LoadMcpConfigOptions): LoadedMcpConfig {
  const bubbleHome = options.bubbleHome ?? process.env.BUBBLE_HOME ?? join(homedir(), ".bubble");
  const paths: Record<"user" | "project" | "local", string> = {
    user: join(bubbleHome, "settings.json"),
    project: join(options.cwd, ".bubble", "settings.json"),
    local: join(options.cwd, ".bubble", "settings.local.json"),
  };

  const diagnostics: McpConfigDiagnostic[] = [];
  const merged = new Map<string, ScopedMcpServerConfig>();

  for (const scope of ["user", "project", "local"] as const) {
    const path = paths[scope];
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      diagnostics.push({ scope, path, message: `Failed to parse: ${(err as Error).message}` });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const mcpServers = (raw as { mcpServers?: unknown }).mcpServers;
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) continue;

    for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
      const validated = validateServerConfig(value, (msg) => {
        diagnostics.push({ scope, path, message: `mcpServers.${name}: ${msg}` });
      });
      if (!validated) continue;

      const expanded = expandConfigEnv(validated, (missing) => {
        diagnostics.push({
          scope,
          path,
          message: `mcpServers.${name}: env var "${missing}" is not set; expanded to empty string.`,
        });
      });

      if (merged.has(name)) {
        diagnostics.push({
          scope,
          path,
          message: `mcpServers.${name}: overrides entry from ${merged.get(name)!.scope} scope.`,
        });
      }
      merged.set(name, { name, scope, config: expanded });
    }
  }

  return { servers: [...merged.values()], diagnostics };
}

function validateServerConfig(value: unknown, report: (msg: string) => void): McpServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    report("expected an object");
    return null;
  }
  const v = value as Record<string, unknown>;
  const type = typeof v.type === "string" ? v.type : v.command ? "stdio" : undefined;

  if (type === "stdio") {
    if (typeof v.command !== "string" || !v.command.trim()) {
      report('stdio server requires a non-empty "command"');
      return null;
    }
    const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [];
    const env = v.env && typeof v.env === "object" && !Array.isArray(v.env)
      ? Object.fromEntries(
          Object.entries(v.env as Record<string, unknown>).filter(([, val]) => typeof val === "string"),
        ) as Record<string, string>
      : undefined;
    const cwd = typeof v.cwd === "string" ? v.cwd : undefined;
    return { type: "stdio", command: v.command, args, env, cwd };
  }

  if (type === "http" || type === "sse") {
    if (typeof v.url !== "string" || !v.url.trim()) {
      report(`${type} server requires a non-empty "url"`);
      return null;
    }
    const headers = v.headers && typeof v.headers === "object" && !Array.isArray(v.headers)
      ? Object.fromEntries(
          Object.entries(v.headers as Record<string, unknown>).filter(([, val]) => typeof val === "string"),
        ) as Record<string, string>
      : undefined;
    return { type, url: v.url, headers };
  }

  report(`unsupported transport type "${String(v.type)}" (expected "stdio", "http", or "sse")`);
  return null;
}

function expandEnv(input: string, onMissing: (name: string) => void): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      onMissing(name);
      return "";
    }
    return value;
  });
}

function expandConfigEnv(
  config: McpServerConfig,
  onMissing: (name: string) => void,
): McpServerConfig {
  if (config.type === "stdio") {
    return {
      type: "stdio",
      command: expandEnv(config.command, onMissing),
      args: config.args?.map((a) => expandEnv(a, onMissing)),
      env: config.env
        ? Object.fromEntries(
            Object.entries(config.env).map(([k, v]) => [k, expandEnv(v, onMissing)]),
          )
        : undefined,
      cwd: config.cwd ? expandEnv(config.cwd, onMissing) : undefined,
    };
  }
  return {
    type: config.type,
    url: expandEnv(config.url, onMissing),
    headers: config.headers
      ? Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, expandEnv(v, onMissing)]))
      : undefined,
  };
}

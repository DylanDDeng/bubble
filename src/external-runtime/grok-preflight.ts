import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { GrokProfile } from "./grok-profile.js";
import { isSafeGrokSkillName } from "./grok-profile.js";
import type { GrokSpawn } from "./grok-process.js";
import { runGrokCommand } from "./grok-process.js";
import { GrokRuntimeError } from "./grok-errors.js";

/**
 * How a workspace-scoped preflight may relax the empty-surface rule. The
 * pinned Grok CLI always *lists* project-level extensions in `inspect`, even
 * when their loading is disabled, so a workspace containing its own
 * `.grok/skills` or `.agents/skills` directories can never produce an empty
 * report. Loading is prevented instead: every discovered project skill must be
 * written into the profile's `[skills] disabled` list before the sidecar
 * starts, and MCP entries are acceptable only when they come from the
 * cursor/claude compatibility scanners that the profile verifiably disables
 * (agent-stdio sessions additionally use only the MCP servers passed by
 * Bubble, which passes none).
 */
export interface GrokWorkspaceExtensionPolicy {
  allowedProjectSkills: ReadonlySet<string>;
  allowCompatMcpServers: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEmptyArray(root: JsonRecord, key: string): void {
  const value = root[key];
  if (!Array.isArray(value) || value.length !== 0) {
    throw new GrokRuntimeError("preflight_failed", `Grok isolation check failed: ${key} must be empty.`);
  }
}

function sourcePath(value: unknown): string | undefined {
  if (typeof value === "string") {
    // Grok 0.2.93 renders permission origins as
    // "/absolute/file.toml (config)" in inspect JSON.
    return value.replace(/\s+\((?:config|requirements)\)$/, "");
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["path", "file", "sourcePath"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  const source = value.source;
  if (typeof source === "string" && source.startsWith("/")) return source;
  if (isRecord(source)) return sourcePath(source);
  return undefined;
}

async function canonicalOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Render a workspace-controlled path safely inside an error message. */
function describeForeignPath(path: string | undefined): string {
  if (!path) return "an unidentified configuration source";
  const printable = path.replace(/[\p{Cc}\p{Cf}]/gu, "?");
  return printable.length > 160 ? `${printable.slice(0, 157)}...` : printable;
}

/**
 * The directory subtree Grok legitimately scans for project extensions: the
 * validated project root when the workspace sits inside one, otherwise the
 * workspace itself.
 */
async function workspaceExtensionScope(payload: JsonRecord, workspace: string): Promise<string> {
  const expectedCwd = await canonicalOrResolved(workspace);
  if (typeof payload.projectRoot === "string") {
    const projectRoot = await canonicalOrResolved(payload.projectRoot);
    if (expectedCwd === projectRoot || expectedCwd.startsWith(`${projectRoot}${sep}`)) return projectRoot;
  }
  return expectedCwd;
}

/**
 * Collect the names of every skill Grok discovered for this workspace so they
 * can be written into the profile's `[skills] disabled` list. Fails closed on
 * any skill that is not a plain project-level discovery inside the workspace
 * scope, or whose name cannot be disabled safely.
 */
export async function collectGrokProjectSkills(payload: unknown, workspace: string): Promise<string[]> {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) {
    throw new GrokRuntimeError("preflight_failed", "Grok isolation check returned invalid skill data.");
  }
  const scope = await workspaceExtensionScope(payload, workspace);
  const names = new Set<string>();
  for (const entry of payload.skills) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !isSafeGrokSkillName(entry.name)) {
      throw new GrokRuntimeError("preflight_failed", "Grok discovered a skill Bubble cannot disable safely.");
    }
    const source = entry.source;
    if (!isRecord(source) || source.type !== "project" || typeof source.path !== "string") {
      throw new GrokRuntimeError(
        "preflight_failed",
        `Grok discovered the skill "${entry.name}" outside the workspace project scope.`,
      );
    }
    const path = await canonicalOrResolved(source.path);
    if (path !== scope && !path.startsWith(`${scope}${sep}`)) {
      throw new GrokRuntimeError(
        "preflight_failed",
        `Grok discovered the skill "${entry.name}" outside the workspace project scope.`,
      );
    }
    names.add(entry.name);
  }
  return [...names].sort();
}

export async function validateGrokInspect(
  payload: unknown,
  profile: GrokProfile,
  workspace = profile.workspace,
  policy?: GrokWorkspaceExtensionPolicy,
): Promise<void> {
  if (!isRecord(payload)) throw new GrokRuntimeError("preflight_failed", "Grok isolation check returned invalid data.");
  const expectedCwd = await canonicalOrResolved(workspace);
  if (typeof payload.cwd !== "string" || (await canonicalOrResolved(payload.cwd)) !== expectedCwd) {
    throw new GrokRuntimeError("preflight_failed", "Grok isolation check used an unexpected workspace.");
  }
  if (payload.projectRoot !== null) {
    if (typeof payload.projectRoot !== "string") {
      throw new GrokRuntimeError("preflight_failed", "Grok isolation check returned an invalid project root.");
    }
    const projectRoot = await canonicalOrResolved(payload.projectRoot);
    if (expectedCwd !== projectRoot && !expectedCwd.startsWith(`${projectRoot}${sep}`)) {
      throw new GrokRuntimeError("preflight_failed", "Grok isolation check discovered an unrelated project root.");
    }
  }
  for (const key of ["projectInstructions", "hooks", "plugins", "marketplaces", "lspServers"]) {
    requireEmptyArray(payload, key);
  }
  if (policy) {
    for (const name of await collectGrokProjectSkills(payload, workspace)) {
      if (!policy.allowedProjectSkills.has(name)) {
        throw new GrokRuntimeError(
          "preflight_failed",
          `Grok discovered the workspace skill "${name}" that Bubble has not disabled.`,
        );
      }
    }
  } else {
    requireEmptyArray(payload, "skills");
  }
  if (policy?.allowCompatMcpServers) {
    const mcpServers = payload.mcpServers;
    if (!Array.isArray(mcpServers)) {
      throw new GrokRuntimeError("preflight_failed", "Grok isolation check returned invalid MCP data.");
    }
    for (const entry of mcpServers) {
      // Compat-scanner discoveries stay listed even though the disabled
      // compatibility cells (verified below) and Bubble's empty session MCP
      // list keep them from loading. Anything else fails closed.
      if (!isRecord(entry) || (entry.vendor !== "cursor" && entry.vendor !== "claude")) {
        throw new GrokRuntimeError("preflight_failed", "Grok discovered an MCP server it could load.");
      }
    }
  } else {
    requireEmptyArray(payload, "mcpServers");
  }

  const externalCompat = payload.externalCompat;
  if (!isRecord(externalCompat) || !Array.isArray(externalCompat.cells) || externalCompat.cells.length === 0) {
    throw new GrokRuntimeError("preflight_failed", "Grok compatibility scanners could not be verified as disabled.");
  }
  for (const cell of externalCompat.cells) {
    if (!isRecord(cell) || cell.enabled !== false) {
      throw new GrokRuntimeError("preflight_failed", "Grok compatibility scanners are not fully disabled.");
    }
  }

  const allowedSources = new Set([
    await canonicalOrResolved(profile.configPath),
    await canonicalOrResolved(profile.requirementsPath),
  ]);
  const permissions = payload.permissions;
  if (!isRecord(permissions) || !Array.isArray(permissions.sources)) {
    throw new GrokRuntimeError("preflight_failed", "Grok permission sources could not be verified.");
  }
  for (const source of permissions.sources) {
    const path = sourcePath(source);
    if (!path || !allowedSources.has(await canonicalOrResolved(path))) {
      throw new GrokRuntimeError("preflight_failed", "Grok discovered a permission source outside Bubble's isolated profile.");
    }
  }
  if (Array.isArray(permissions.skipped) && permissions.skipped.length > 0) {
    throw new GrokRuntimeError("preflight_failed", "Grok discovered an unverified permission source.");
  }
  if (permissions.managedSettingsActive === true) {
    throw new GrokRuntimeError("preflight_failed", "Grok discovered active managed settings outside Bubble's isolated profile.");
  }

  const configSources = payload.configSources;
  if (isRecord(configSources) && Array.isArray(configSources.layers)) {
    for (const layer of configSources.layers) {
      const path = sourcePath(layer);
      if (!path || !allowedSources.has(await canonicalOrResolved(path))) {
        // A project-scope config layer overrides the isolated profile's
        // settings (verified on the pinned CLI: it can re-enable disabled
        // skills past requirements.toml), so it can never be allowed.
        throw new GrokRuntimeError(
          "preflight_failed",
          `Grok would load ${describeForeignPath(path)} as project configuration. Start Bubble in a workspace without its own Grok config file.`,
        );
      }
    }
  }
}

export async function runGrokInspectJson(
  spawn: GrokSpawn,
  binary: string,
  profile: GrokProfile,
  env: NodeJS.ProcessEnv,
  workspace = profile.workspace,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await runGrokCommand(
    spawn,
    binary,
    ["--no-auto-update", "--cwd", workspace, "inspect", "--json"],
    { cwd: workspace, env, signal },
  );
  if (result.code !== 0) {
    throw new GrokRuntimeError("preflight_failed", "Grok isolation check failed to run.", result.stderr);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GrokRuntimeError("preflight_failed", "Grok isolation check returned invalid JSON.");
  }
}

export async function runGrokPreflight(
  spawn: GrokSpawn,
  binary: string,
  profile: GrokProfile,
  env: NodeJS.ProcessEnv,
  workspace = profile.workspace,
  signal?: AbortSignal,
  policy?: GrokWorkspaceExtensionPolicy,
): Promise<void> {
  const payload = await runGrokInspectJson(spawn, binary, profile, env, workspace, signal);
  await validateGrokInspect(payload, profile, workspace, policy);
}

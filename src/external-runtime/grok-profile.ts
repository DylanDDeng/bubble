import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import { GrokRuntimeError } from "./grok-errors.js";

export interface GrokProfile {
  root: string;
  home: string;
  grokHome: string;
  tmp: string;
  workspace: string;
  configPath: string;
  requirementsPath: string;
  lockPath: string;
}

export interface GrokProfileLock {
  release(): Promise<void>;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

// Skills the pinned Grok CLI bundles and can materialize on its own. They are
// disabled by name because the runtime re-creates their files at startup.
const GROK_BUNDLED_SKILLS = [
  "code-review",
  "xlsx",
  "create-skill",
  "pptx",
  "check-work",
  "docx",
  "imagine",
  "help",
] as const;

// `[skills] disabled` entries are written into TOML basic strings. Only accept
// names that cannot alter the document structure or smuggle escapes.
const SAFE_GROK_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeGrokSkillName(name: string): boolean {
  return SAFE_GROK_SKILL_NAME.test(name);
}

function grokDisabledSkillsLine(extraDisabledSkills: readonly string[]): string {
  for (const name of extraDisabledSkills) {
    if (!isSafeGrokSkillName(name)) {
      throw new GrokRuntimeError("profile_unsafe", "A discovered Grok skill name cannot be disabled safely.");
    }
  }
  const disabled = [...new Set([...GROK_BUNDLED_SKILLS, ...extraDisabledSkills])].sort();
  return `disabled = [${disabled.map((name) => JSON.stringify(name)).join(", ")}]`;
}

// Keep credentials and runtime configuration isolated while allowing the
// official Grok runtime to work inside the user's selected workspace. Tool
// execution is still gated by ACP permission requests handled by Bubble.
export function buildGrokConfigToml(extraDisabledSkills: readonly string[] = []): string {
  return `[cli]
auto_update = false

[session]
load_envrc = false

[sandbox]
profile = "strict"
auto_allow_bash = false

[features]
web_fetch = false
write_file = true
tool_search = false
lsp_tools = false

[subagents]
enabled = false

[memory]
enabled = false

[skills]
${grokDisabledSkillsLine(extraDisabledSkills)}

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false

# Grok's Claude permission compatibility is independent from the extension
# compatibility switches above. Mark the one-time import as complete so the
# runtime never reads workspace .claude/settings*.json permission rules.
[claude_compat]
imported = true
`;
}

export function buildGrokRequirementsToml(extraDisabledSkills: readonly string[] = []): string {
  return `[cli]
auto_update = false

[session]
load_envrc = false

[sandbox]
profile = "strict"
auto_allow_bash = false

[features]
web_fetch = false
write_file = true
tool_search = false
lsp_tools = false

[subagents]
enabled = false

[memory]
enabled = false

[skills]
${grokDisabledSkillsLine(extraDisabledSkills)}

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false

[claude_compat]
imported = true
`;
}

export const GROK_CONFIG_TOML = buildGrokConfigToml();

export const GROK_REQUIREMENTS_TOML = buildGrokRequirementsToml();

export function getGrokProfile(bubbleHome = getBubbleHome()): GrokProfile {
  const root = resolve(bubbleHome, "runtimes", "grok");
  const grokHome = join(root, "grok-home");
  return {
    root,
    home: join(root, "home"),
    grokHome,
    tmp: join(root, "tmp"),
    workspace: join(root, "workspace"),
    configPath: join(grokHome, "config.toml"),
    requirementsPath: join(grokHome, "requirements.toml"),
    lockPath: join(root, "runtime.lock"),
  };
}

async function ensurePrivateDirectory(path: string, uid: number, repairMode = true): Promise<void> {
  let created = false;
  try {
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid) {
      throw new GrokRuntimeError("profile_unsafe", "The isolated Grok profile contains an unsafe path.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    created = true;
  }
  if (created || repairMode) await chmod(path, DIRECTORY_MODE);
  const after = await stat(path);
  if (!after.isDirectory() || after.uid !== uid || (after.mode & 0o077) !== 0) {
    throw new GrokRuntimeError("profile_unsafe", "The isolated Grok profile must be private to the current user.");
  }
}

/**
 * Establish only the private directory needed to create runtime.lock. Existing
 * profile content is validated but never chmodded or rewritten here, because
 * another Bubble process may already own the lock and be using that profile.
 */
export async function prepareGrokProfileLockRoot(
  profile = getGrokProfile(),
  uid = process.getuid?.(),
): Promise<GrokProfile> {
  if (uid === undefined) {
    throw new GrokRuntimeError("unsupported_platform", "The Grok runtime requires a POSIX user account.");
  }
  await ensurePrivateDirectory(dirname(profile.root), uid, false);
  await ensurePrivateDirectory(profile.root, uid, false);
  return profile;
}

async function writePrivateFile(path: string, contents: string, uid: number): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid) {
      throw new GrokRuntimeError("profile_unsafe", "The isolated Grok profile contains an unsafe configuration file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  await chmod(path, FILE_MODE);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    throw new GrokRuntimeError("profile_unsafe", "The isolated Grok configuration must be private to the current user.");
  }
}

export async function prepareGrokProfile(
  profile = getGrokProfile(),
  uid = process.getuid?.(),
  extraDisabledSkills: readonly string[] = [],
): Promise<GrokProfile> {
  if (uid === undefined) {
    throw new GrokRuntimeError("unsupported_platform", "The Grok runtime requires a POSIX user account.");
  }
  await ensurePrivateDirectory(dirname(profile.root), uid);
  await ensurePrivateDirectory(profile.root, uid);
  for (const path of [profile.home, profile.grokHome, profile.tmp, profile.workspace]) {
    await ensurePrivateDirectory(path, uid);
  }
  const canonicalRoot = await realpath(profile.root);
  for (const path of [profile.home, profile.grokHome, profile.tmp, profile.workspace]) {
    const canonical = await realpath(path);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
      throw new GrokRuntimeError("profile_unsafe", "The isolated Grok profile escaped its private root.");
    }
  }
  await writePrivateFile(profile.configPath, buildGrokConfigToml(extraDisabledSkills), uid);
  await writePrivateFile(profile.requirementsPath, buildGrokRequirementsToml(extraDisabledSkills), uid);
  return profile;
}

export function buildGrokChildEnv(
  profile: GrokProfile,
  parentEnv: NodeJS.ProcessEnv = process.env,
  proxy?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: profile.home,
    GROK_HOME: profile.grokHome,
    TMPDIR: profile.tmp,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_SANDBOX: "strict",
    GROK_SANDBOX_AUTO_ALLOW_BASH: "0",
    GROK_MEMORY: "0",
    GROK_SUBAGENTS: "0",
    GROK_WEB_FETCH: "0",
    GROK_WRITE_FILE: "1",
    GROK_TOOL_SEARCH: "0",
    GROK_LSP_TOOLS: "0",
    GROK_CURSOR_SKILLS_ENABLED: "0",
    GROK_CURSOR_RULES_ENABLED: "0",
    GROK_CURSOR_AGENTS_ENABLED: "0",
    GROK_CURSOR_MCPS_ENABLED: "0",
    GROK_CURSOR_HOOKS_ENABLED: "0",
    GROK_CLAUDE_SKILLS_ENABLED: "0",
    GROK_CLAUDE_RULES_ENABLED: "0",
    GROK_CLAUDE_AGENTS_ENABLED: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    // Pinned Grok 0.2.93 has a separate Claude permission compatibility gate.
    // Keep its exact process override as defense in depth for every child.
    _GROK_CLAUDE_MARKER_OVERRIDE: "1",
    GROK_CRASH_HANDLER: "0",
  };
  const uid = process.getuid?.();
  const safePath = parentEnv.PATH?.split(":").filter((entry) => {
    if (!entry.startsWith("/") || /[\r\n\0]/.test(entry)) return false;
    try {
      const canonical = realpathSync(entry);
      const metadata = statSync(canonical);
      return metadata.isDirectory()
        && (uid === undefined || metadata.uid === 0 || metadata.uid === uid)
        && (metadata.mode & 0o022) === 0;
    } catch {
      return false;
    }
  });
  if (safePath?.length) env.PATH = [...new Set(safePath)].join(":");
  for (const name of ["LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR"] as const) {
    const value = parentEnv[name];
    if (value && !/[\r\n\0]/.test(value)) env[name] = value;
  }
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.ALL_PROXY = proxy;
  }
  return env;
}

export async function acquireGrokProfileLock(profile: GrokProfile): Promise<GrokProfileLock> {
  const uid = process.getuid?.();
  const openNewLock = async () => await open(profile.lockPath, "wx", FILE_MODE);
  let handle;
  try {
    handle = await openNewLock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = await lstat(profile.lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || uid === undefined || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
      throw new GrokRuntimeError("profile_unsafe", "The isolated Grok runtime lock is unsafe.");
    }
    const rawPid = (await readFile(profile.lockPath, "utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(rawPid)) {
      throw new GrokRuntimeError("profile_unsafe", "The isolated Grok runtime lock is invalid.");
    }
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) {
      throw new GrokRuntimeError("profile_unsafe", "The isolated Grok runtime lock is invalid.");
    }
    let stale = false;
    try {
      process.kill(pid, 0);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === "ESRCH") stale = true;
      else throw new GrokRuntimeError("profile_locked", "The isolated Grok runtime is already in use.");
    }
    if (!stale) {
      throw new GrokRuntimeError("profile_locked", "The isolated Grok runtime is already in use.");
    }
    await rm(profile.lockPath);
    try {
      handle = await openNewLock();
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
        throw new GrokRuntimeError("profile_locked", "The isolated Grok runtime is already in use.");
      }
      throw retryError;
    }
  }
  await handle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await rm(profile.lockPath, { force: true });
    },
  };
}

export async function grokProfileHasAuth(profile: GrokProfile): Promise<boolean> {
  for (const path of [join(profile.grokHome, "auth.json"), join(profile.grokHome, "auth")]) {
    try {
      const metadata = await lstat(path);
      if (metadata.isFile() || metadata.isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

export async function clearGrokRuntimeData(profile: GrokProfile, includeAuth: boolean): Promise<void> {
  const names = [
    "sessions",
    "logs",
    "log",
    "crash",
    "leader.sock",
    "leader.pid",
    "socket",
    "sockets",
    "active_sessions.json",
    "active_sessions.lock",
    "sandbox-events.jsonl",
    "auth.json.lock",
  ];
  if (includeAuth) names.push("auth.json", "auth");
  for (const name of names) {
    await rm(join(profile.grokHome, name), { recursive: true, force: true });
  }
  // OAuth helpers may place browser hand-off logs or sockets under TMPDIR.
  // The directory is dedicated to this isolated runtime, so clear and
  // recreate it at every authentication boundary.
  await rm(profile.tmp, { recursive: true, force: true });
  await mkdir(profile.tmp, { mode: DIRECTORY_MODE });
  await chmod(profile.tmp, DIRECTORY_MODE);
  // The process workspace is intentionally disposable and never points at the user's project.
  await rm(profile.workspace, { recursive: true, force: true });
  await mkdir(profile.workspace, { mode: DIRECTORY_MODE });
  await chmod(profile.workspace, DIRECTORY_MODE);
}

/** Remove extension surfaces that the pinned CLI may materialize at startup. */
export async function clearGrokGeneratedExtensions(profile: GrokProfile): Promise<void> {
  for (const name of [
    "skills",
    "plugins",
    "marketplaces",
    "hooks",
    "agents",
    "mcp",
    "lsp",
    "docs",
    // The pinned CLI can materialize transcript-bearing archives and logs
    // even with memory disabled. They are never inputs to a later turn.
    "upload_queue",
    "logs",
    "log",
    "crash",
    "sandbox-events.jsonl",
    "README.md",
    ".config-init.lock",
    "managed_config.lock",
    "auth.json.lock",
    "active_sessions.json",
    "active_sessions.lock",
    "leader.sock",
    "leader.pid",
    "socket",
    "sockets",
  ]) {
    await rm(join(profile.grokHome, name), { recursive: true, force: true });
  }
  // Bundled skills/docs are written under isolated HOME rather than GROK_HOME.
  // Remove them after every short-lived process so the next preflight/sidecar
  // starts from the same empty extension surface it verified.
  await rm(join(profile.home, ".grok"), { recursive: true, force: true });
}

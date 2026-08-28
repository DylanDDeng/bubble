/**
 * Self-update: `bubble update` / `bubble upgrade`, plus a cached startup
 * "update available" check.
 *
 * Bubble ships as the npm package `@bubblebrain-ai/bubble`. Updating just means
 * re-installing it globally with whatever package manager put it there, so we
 * detect the install method and run the matching command.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

const require = createRequire(import.meta.url);

export const PACKAGE_NAME = "@bubblebrain-ai/bubble";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
// Throttle for the startup registry check. Short on purpose: with frequent
// releases, a long TTL means users only learn about a new version a day late.
const REFRESH_THROTTLE_MS = 30 * 60 * 1000;

export function getCurrentVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function fetchLatestVersion(timeoutMs = 5000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: string };
      return data.version ?? null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Compare two semver-ish strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Handles `x.y.z` and a single pre-release tag (`x.y.z-beta.1`); a release
 * always outranks a pre-release of the same numeric version.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const cleaned = v.trim().replace(/^v/, "");
    const [core, pre] = cleaned.split("-", 2);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! > pb.nums[i]!) return 1;
    if (pa.nums[i]! < pb.nums[i]!) return -1;
  }
  // Equal numeric core: no pre-release beats a pre-release.
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

export type PackageManager = "npm" | "bun" | "pnpm" | "yarn" | "homebrew" | "unknown";

export interface InstallInfo {
  manager: PackageManager;
  isGlobal: boolean;
  isLocalCheckout: boolean;
  installPath: string;
}

export function detectInstallFromPath(installPath: string): InstallInfo {
  const lower = installPath.replace(/\\/g, "/").toLowerCase();
  const isUnderNodeModules = lower.includes("/node_modules/");
  // A dev/source checkout has src/ alongside dist/ and isn't under node_modules.
  const isLocalCheckout = !isUnderNodeModules;

  let manager: PackageManager = "unknown";
  // Package-manager-specific node_modules layouts take precedence over a
  // parent directory name (for example /opt/homebrew/lib/node_modules is npm).
  if (lower.includes("/.bun/") || lower.includes("/bun/install/")) {
    manager = "bun";
  } else if (lower.includes("/pnpm/") || lower.includes("/.pnpm/")) {
    manager = "pnpm";
  } else if (lower.includes("/.yarn/") || lower.includes("/yarn/global")) {
    manager = "yarn";
  } else if (isUnderNodeModules) {
    manager = "npm";
  } else if (lower.includes("/cellar/") || lower.includes("/homebrew/")) {
    manager = "homebrew";
  }

  return { manager, isGlobal: isUnderNodeModules, isLocalCheckout, installPath };
}

/**
 * Figure out how this copy of Bubble was installed by inspecting the real path
 * of the package directory (two levels up from this module: dist/update -> pkg).
 */
export function detectInstall(): InstallInfo {
  const rawRoot = fileURLToPath(new URL("../../", import.meta.url));
  let installPath = rawRoot;
  try {
    installPath = realpathSync(rawRoot);
  } catch {
    // keep rawRoot
  }
  return detectInstallFromPath(installPath);
}

export function upgradeCommandFor(manager: PackageManager): { cmd: string; args: string[] } | null {
  const spec = `${PACKAGE_NAME}@latest`;
  switch (manager) {
    case "npm":
    case "unknown": // default to npm
      return { cmd: "npm", args: ["install", "-g", spec] };
    case "bun":
      return { cmd: "bun", args: ["add", "-g", spec] };
    case "pnpm":
      return { cmd: "pnpm", args: ["add", "-g", spec] };
    case "yarn":
      return { cmd: "yarn", args: ["global", "add", spec] };
    case "homebrew":
      return null; // handled separately (brew upgrade)
  }
}

function spawnInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * `bubble update` entry point. Returns a process exit code.
 */
export async function runUpdateCommand(opts: { checkOnly?: boolean } = {}): Promise<number> {
  const current = getCurrentVersion();
  process.stdout.write(`Bubble v${current}\n`);
  process.stdout.write("Checking npm for the latest version…\n");

  const latest = await fetchLatestVersion();
  if (!latest) {
    process.stderr.write("Could not reach the npm registry. Check your connection and try again.\n");
    return 1;
  }

  if (compareVersions(latest, current) <= 0) {
    process.stdout.write(`You're already on the latest version (v${current}).\n`);
    return 0;
  }

  process.stdout.write(`Update available: v${current} → v${latest}\n`);
  if (opts.checkOnly) {
    process.stdout.write("Run `bubble update` to install it.\n");
    return 0;
  }

  const info = detectInstall();
  if (info.isLocalCheckout) {
    process.stderr.write(
      "This looks like a local/development checkout, not a global install.\n" +
        "Update it with:\n  git pull && npm run build\n",
    );
    return 1;
  }
  if (info.manager === "homebrew") {
    process.stderr.write("Bubble was installed via Homebrew. Update it with:\n  brew upgrade bubble\n");
    return 1;
  }

  const command = upgradeCommandFor(info.manager);
  if (!command) {
    process.stderr.write(
      `Couldn't determine how to update automatically. Run:\n  npm install -g ${PACKAGE_NAME}@latest\n`,
    );
    return 1;
  }

  process.stdout.write(`\nUpdating via ${command.cmd}…\n\n`);
  const code = await spawnInherit(command.cmd, command.args);
  if (code === 0) {
    process.stdout.write(`\n✓ Updated to v${latest}. Restart bubble to use the new version.\n`);
    return 0;
  }

  process.stderr.write(
    `\nUpdate failed (exit ${code}). Try running it manually:\n  ${command.cmd} ${command.args.join(" ")}\n` +
      "If this is a permissions error, you may need elevated privileges or to fix your global install prefix.\n",
  );
  return code;
}

// ---------------------------------------------------------------------------
// Cached startup check ("update available" nudge)
// ---------------------------------------------------------------------------

interface UpdateCache {
  lastCheck: number;
  latest: string;
}

function cacheFile(): string {
  return join(getBubbleHome(), "update-check.json");
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(cacheFile(), "utf8");
    const data = JSON.parse(raw) as Partial<UpdateCache>;
    if (typeof data.lastCheck === "number" && typeof data.latest === "string") {
      return { lastCheck: data.lastCheck, latest: data.latest };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  try {
    const file = cacheFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache), "utf8");
  } catch {
    // best-effort; never fail startup over a cache write
  }
}

function formatUpdateNotice(current: string, latest: string): string {
  return `Update available: v${current} → v${latest} · run \`bubble update\``;
}

export interface StartupUpdateCheck {
  /** Notice derived from the local cache — available immediately, no network. */
  notice: string | null;
  /**
   * Resolves once the background registry check completes: a notice string
   * when it finds a version newer than both the running one and the cached
   * `notice`, otherwise null. Never rejects.
   */
  refreshed: Promise<string | null>;
}

/**
 * Startup "update available" check. The immediate `notice` comes from the
 * local cache file (fast, no network on the hot path). A registry refresh
 * always runs in the background (throttled to once per 30 minutes) so a
 * release published since the last launch surfaces in the *current* session
 * via `refreshed`, instead of only after the cache TTL plus another restart.
 * Never throws.
 */
export async function startStartupUpdateCheck(): Promise<StartupUpdateCheck> {
  try {
    const current = getCurrentVersion();
    const now = Date.now();
    const cache = await readCache();
    const notice = cache && compareVersions(cache.latest, current) > 0
      ? formatUpdateNotice(current, cache.latest)
      : null;
    const refreshed = (async (): Promise<string | null> => {
      try {
        if (cache && now - cache.lastCheck < REFRESH_THROTTLE_MS) return null;
        const latest = await fetchLatestVersion(4000);
        if (!latest) return null;
        await writeCache({ lastCheck: now, latest });
        if (compareVersions(latest, current) <= 0) return null;
        // The cache already surfaced this version in `notice` — stay quiet.
        if (notice && cache && compareVersions(latest, cache.latest) <= 0) return null;
        return formatUpdateNotice(current, latest);
      } catch {
        return null;
      }
    })();
    return { notice, refreshed };
  } catch {
    return { notice: null, refreshed: Promise.resolve(null) };
  }
}

/** Cache-only variant of {@link startStartupUpdateCheck} (still refreshes in the background). */
export async function getStartupUpdateNotice(): Promise<string | null> {
  const check = await startStartupUpdateCheck();
  return check.notice;
}

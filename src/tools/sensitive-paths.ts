import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

/**
 * Credential storage the no-prompt tools (read, grep, ls, edit excerpts) must
 * never open. Reading never asks for approval, and neither do web fetches, so
 * without this a prompt-injected model could read a private key and send it
 * out without a single prompt. Bash is not covered here beyond Bubble's own
 * files: bash commands are shown to the user before they run.
 */
export function getSensitivePaths(): string[] {
  const bubbleHome = getBubbleHome();
  return [
    resolve(bubbleHome, "config.json"),
    resolve(bubbleHome, "auth.json"),
  ];
}

/** Home-relative credential files. */
const HOME_CREDENTIAL_FILES = [
  ".aws/credentials",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  ".kube/config",
  ".config/gh/hosts.yml",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".terraform.d/credentials.tfrc.json",
  ".codex/auth.json",
  ".claude/.credentials.json",
];

/** Home-relative directories whose whole content is credential material. */
const HOME_CREDENTIAL_DIRS = [
  ".gnupg",
  ".password-store",
  ".config/gcloud",
  ".azure",
  ".config/op",
  ".aws/sso/cache",
  ".aws/cli/cache",
  "Library/Keychains",
];

/** Non-secret files in ~/.ssh; everything else there (private keys) is blocked. */
const SSH_PUBLIC_FILES = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys"]);

export function isSensitivePath(filePath: string): boolean {
  const candidates = new Set([resolve(filePath)]);
  // A symlink inside the workspace must not smuggle a credential file out.
  try {
    candidates.add(realpathSync(filePath));
  } catch {
    // Missing files have no link target to check.
  }
  return [...candidates].some(isSensitiveResolved);
}

function isSensitiveResolved(resolvedPath: string): boolean {
  // Case-folded: on the default macOS (and Windows) filesystem
  // `~/.AWS/Credentials` opens `~/.aws/credentials`. On case-sensitive
  // systems this only blocks a few more look-alike paths.
  const path = resolvedPath.toLowerCase();
  if (getSensitivePaths().some((sensitive) => sensitive.toLowerCase() === path)) return true;
  // Compare against the home directory as written and as resolved, so a
  // resolved link target still lines up when home itself sits behind a link.
  return homeForms().some((home) => isSensitiveUnderHome(path, home.toLowerCase()));
}

function homeForms(): string[] {
  const home = homedir();
  try {
    const real = realpathSync(home);
    return real === home ? [home] : [home, real];
  } catch {
    return [home];
  }
}

function isSensitiveUnderHome(path: string, home: string): boolean {
  if (HOME_CREDENTIAL_FILES.some((file) => path === resolve(home, file.toLowerCase()))) return true;
  if (HOME_CREDENTIAL_DIRS.some((dir) => isInside(path, resolve(home, dir.toLowerCase())))) return true;
  const ssh = resolve(home, ".ssh");
  if (dirname(path) === ssh) {
    const name = basename(path);
    return !SSH_PUBLIC_FILES.has(name) && !name.endsWith(".pub");
  }
  return isInside(path, ssh) && path !== ssh;
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/** Bash commands may not name Bubble's own credential files. */
export function referencesSensitivePath(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.includes("~/.bubble/config.json") || lower.includes("~/.bubble/auth.json")) {
    return true;
  }
  return getSensitivePaths().some((filePath) => {
    const normalized = filePath.replace(/\\/g, "/");
    return lower.includes(normalized.toLowerCase()) || lower.includes(normalized.toLowerCase().replace(homedir().toLowerCase(), "~"));
  });
}

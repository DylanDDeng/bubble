import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveThroughLinks } from "../tools/path-utils.js";

/**
 * Workspace files whose content grants capabilities beyond the edit itself.
 * Default mode auto-approves ordinary workspace edits; these always ask,
 * because writing them is a privilege escalation rather than a code change:
 *
 * - anything inside a `.git` directory — hooks and `core.hooksPath` /
 *   `core.fsmonitor` in `.git/config` run arbitrary commands the next time
 *   anyone runs git;
 * - agent permission settings (`.bubble/settings*.json`, and Claude Code's
 *   `.claude/settings*.json`) — an allow rule written there approves every
 *   later command without a prompt.
 */
const PROTECTED_SETTINGS: ReadonlyArray<{ dir: string; files: ReadonlySet<string> }> = [
  { dir: ".bubble", files: new Set(["settings.json", "settings.local.json"]) },
  { dir: ".claude", files: new Set(["settings.json", "settings.local.json"]) },
];

export function isProtectedWorkspacePath(cwd: string, filePath: string): boolean {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  // Also where the path really leads: `docs/hooks -> ../.git/hooks` must not
  // turn a hook into an ordinary auto-approved edit.
  return isProtected(cwd, absolute) || isProtected(resolveThroughLinks(cwd), resolveThroughLinks(absolute));
}

function isProtected(cwd: string, absolute: string): boolean {
  // Case-folded: on the default macOS (and Windows) filesystem `.GIT/config`
  // is `.git/config`. On case-sensitive systems this only asks more often.
  const rel = relative(resolve(cwd), absolute).toLowerCase();
  const parts = rel.split(sep).filter(Boolean);
  if (parts.includes(".git")) return true;
  const parent = basename(dirname(absolute)).toLowerCase();
  const name = basename(absolute).toLowerCase();
  return PROTECTED_SETTINGS.some((entry) => entry.dir === parent && entry.files.has(name));
}

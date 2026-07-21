/**
 * Git-ground-truth change tracking for a single agent run.
 *
 * Tool-metadata bookkeeping (kind === "write" | "edit" | "patch") misses every
 * other mutation channel: bash heredocs/sed -i, scripts, subagent worktree
 * merges. Git sees them all. A baseline snapshot is taken at run start; the
 * delta at completion time is the run's actual footprint.
 *
 * Everything here degrades to null outside a git repo or on any git error —
 * callers fall back to metadata-based signals.
 */

import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 3_000;

export interface GitChangeBaseline {
  /** Paths already dirty (or untracked) before the run started. */
  dirtyAtStart: Set<string>;
}

export interface ModifiedExistingTest {
  path: string;
  deletedLines: number;
}

export interface RunChangeSummary {
  /** Paths that became dirty during the run (not dirty at baseline). */
  changedFiles: string[];
  /**
   * Pre-existing (tracked) test files that were modified during the run,
   * with how many lines the working tree deletes from them vs HEAD. New test
   * files created by the run are NOT listed — creating tests is not suspect.
   */
  modifiedExistingTests: ModifiedExistingTest[];
}

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|spec)(\/|$)|(\.|_|-)(test|tests|spec)\.[^/]+$|(^|\/)test_[^/]+$/i;

export function isTestFilePath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** `git status --porcelain -z` → set of paths with any dirty/untracked state. */
async function dirtyPaths(cwd: string): Promise<Set<string> | null> {
  const out = await git(cwd, ["status", "--porcelain", "-uall", "-z"]);
  if (out === null) return null;
  const paths = new Set<string>();
  for (const entry of out.split("\0")) {
    if (entry.length < 4) continue;
    // "XY path" (rename entries "XY new\0old" — the extra segment lacks the
    // status prefix and is shorter than 4 chars only when degenerate; treat
    // every segment with the status shape as an entry).
    const path = entry.slice(3);
    if (path) paths.add(path);
  }
  return paths;
}

export async function captureGitBaseline(cwd: string): Promise<GitChangeBaseline | null> {
  const dirty = await dirtyPaths(cwd);
  if (dirty === null) return null;
  return { dirtyAtStart: dirty };
}

/**
 * Diff the current working tree against the run-start baseline.
 *
 * Known honest limits: a file already dirty at baseline that the run edited
 * further is not attributed to the run (indistinguishable without content
 * snapshots), and deleted-line counts for such files would mix user and agent
 * edits — so they are excluded entirely.
 */
export async function detectRunChanges(
  cwd: string,
  baseline: GitChangeBaseline | null,
): Promise<RunChangeSummary | null> {
  if (!baseline) return null;
  const dirtyNow = await dirtyPaths(cwd);
  if (dirtyNow === null) return null;

  const changedFiles = [...dirtyNow].filter((path) => !baseline.dirtyAtStart.has(path)).sort();
  if (changedFiles.length === 0) {
    return { changedFiles, modifiedExistingTests: [] };
  }

  // Untracked paths are new files; only tracked files count as "existing".
  const untrackedOut = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = new Set((untrackedOut ?? "").split("\0").filter(Boolean));

  const modifiedExistingTests: ModifiedExistingTest[] = [];
  const candidates = changedFiles.filter((path) => isTestFilePath(path) && !untracked.has(path));
  if (candidates.length > 0) {
    const numstat = await git(cwd, ["diff", "HEAD", "--numstat", "-z", "--", ...candidates]);
    if (numstat !== null) {
      // -z numstat entries: "added\tdeleted\tpath\0" (renames add a segment).
      for (const entry of numstat.split("\0")) {
        const parts = entry.split("\t");
        if (parts.length < 3) continue;
        const deleted = Number(parts[1]);
        const path = parts[2];
        if (!path || Number.isNaN(deleted)) continue;
        modifiedExistingTests.push({ path, deletedLines: deleted });
      }
    }
  }

  return { changedFiles, modifiedExistingTests };
}

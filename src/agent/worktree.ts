/**
 * Git worktree isolation for write-capable subagents (design doc §8).
 *
 * The child works in a runtime-allocated worktree — the parent's working
 * tree is never touched. Unchanged worktrees are removed automatically;
 * changed-but-unapplied ones are kept for the user to inspect.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SubagentWorktree {
  /** Absolute path of the isolated checkout the child works in. */
  path: string;
  /** Main repository root the worktree was created from. */
  repoRoot: string;
  /** Set at finalization: whether the child left any changes behind. */
  changed?: boolean;
  /** Set at finalization: `git diff --stat`-style summary of the changes. */
  diffStat?: string;
  /** Set when the unchanged worktree was removed at finalization. */
  removed?: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/**
 * Allocates a detached worktree at the current HEAD. The path is chosen by
 * the runtime — the child cannot pick it (design §11).
 */
export function createSubagentWorktree(repoCwd: string, agentId: string): SubagentWorktree {
  let repoRoot: string;
  try {
    repoRoot = git(repoCwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error(
      "write_worktree subagents need a git repository: the working directory is not inside one.",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), `bubble-wt-${agentId.slice(0, 8)}-`));
  try {
    git(repoRoot, ["worktree", "add", "--detach", dir, "HEAD"]);
  } catch (error: any) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Failed to create subagent worktree: ${error?.message || String(error)}`);
  }
  return { path: dir, repoRoot };
}

/**
 * Inspects and cleans up a worktree when its child reaches a final state:
 * no changes → remove; changes → keep for parent review, report a diff stat.
 */
export function finalizeSubagentWorktree(worktree: SubagentWorktree): SubagentWorktree {
  if (worktree.changed !== undefined) return worktree; // already finalized
  let porcelain = "";
  let diffStat = "";
  try {
    porcelain = git(worktree.path, ["status", "--porcelain"]).trim();
    diffStat = git(worktree.path, ["diff", "HEAD", "--stat"]).trim();
  } catch {
    // If the worktree vanished, treat it as unchanged.
  }
  const untracked = porcelain
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => `  new file: ${line.slice(3)}`);
  worktree.changed = porcelain.length > 0;
  worktree.diffStat = [diffStat, ...untracked].filter(Boolean).join("\n") || undefined;

  if (!worktree.changed) {
    try {
      git(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
      worktree.removed = true;
    } catch {
      worktree.removed = false;
    }
  }
  return worktree;
}

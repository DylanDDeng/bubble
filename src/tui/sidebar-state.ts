import { execFileSync } from "node:child_process";

export interface SidebarFileChange {
  file: string;
  additions: number;
  deletions: number;
}

export interface SidebarGitState {
  branch?: string;
  files: SidebarFileChange[];
}

export function parseGitNumstat(output: string): SidebarFileChange[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawAdditions, rawDeletions, ...pathParts] = line.split(/\t/);
      const file = pathParts.join("\t").trim();
      if (!file) return undefined;
      return {
        file,
        additions: parseGitCount(rawAdditions),
        deletions: parseGitCount(rawDeletions),
      };
    })
    .filter((item): item is SidebarFileChange => !!item);
}

export function mergeFileChanges(...groups: SidebarFileChange[][]): SidebarFileChange[] {
  const merged = new Map<string, SidebarFileChange>();
  for (const group of groups) {
    for (const item of group) {
      const existing = merged.get(item.file);
      if (!existing) {
        merged.set(item.file, { ...item });
        continue;
      }
      existing.additions += item.additions;
      existing.deletions += item.deletions;
    }
  }
  return [...merged.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function readGitSidebarState(cwd: string): SidebarGitState {
  const branch = runGit(cwd, ["branch", "--show-current"]).trim()
    || runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()
    || undefined;
  const unstaged = parseGitNumstat(runGit(cwd, ["--no-pager", "diff", "--numstat"]));
  const staged = parseGitNumstat(runGit(cwd, ["--no-pager", "diff", "--cached", "--numstat"]));
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => ({ file, additions: 0, deletions: 0 }));
  return {
    branch,
    files: mergeFileChanges(unstaged, staged, untracked),
  };
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 750,
    });
  } catch {
    return "";
  }
}

function parseGitCount(value: string): number {
  if (value === "-") return 0;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? count : 0;
}

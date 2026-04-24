/**
 * Glob tool - discover files by path pattern without shell access.
 */

import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import picomatch from "picomatch";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { isSensitivePath } from "./sensitive-paths.js";

const MAX_RESULTS = 100;
const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

export function createGlobTool(cwd: string): ToolRegistryEntry {
  return {
    name: "glob",
    readOnly: true,
    description: `Find files by glob pattern without using the shell. Use this for project structure discovery and filename searches. Returns up to ${MAX_RESULTS} files sorted by recent modification time.`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files, e.g. '**/*', '**/*.ts', 'src/**/*.tsx'" },
        path: { type: "string", description: "Directory to search in (optional, default: cwd)" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const root = resolve(cwd, typeof args.path === "string" && args.path.trim() ? args.path : ".");
      const pattern = String(args.pattern || "").trim();
      if (!pattern) {
        return { content: "Error: glob pattern is required", isError: true, status: "command_error" };
      }

      if (isSensitivePath(root)) {
        return {
          content: `Error: Glob blocked for sensitive credential storage: ${root}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            path: root,
            pattern,
            reason: "Sensitive credential storage is not searchable from general-purpose tasks.",
          },
        };
      }

      const matcher = picomatch(pattern, { dot: true });
      const files: Array<{ path: string; mtimeMs: number }> = [];
      const truncated = { value: false };

      try {
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) {
          return { content: `Error: Path is not a directory: ${root}`, isError: true, status: "command_error" };
        }
        await walk(root, root, matcher, files, truncated, ctx.abortSignal);
      } catch (error: any) {
        return { content: `Error: Cannot glob path: ${root} (${error?.message || String(error)})`, isError: true, status: "command_error" };
      }

      files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
      const matches = files.slice(0, MAX_RESULTS).map((item) => item.path);
      const wasTruncated = truncated.value || files.length > MAX_RESULTS;

      if (matches.length === 0) {
        return {
          content: "No files found.",
          status: "no_match",
          metadata: {
            kind: "search",
            path: root,
            pattern,
            matches: 0,
            truncated: false,
            searchSignature: `glob:${root}:${pattern}`,
            searchFamily: `glob:${pattern}`,
          },
        };
      }

      return {
        content: `${matches.join("\n")}${wasTruncated ? `\n[More than ${MAX_RESULTS} files, output truncated]` : ""}`,
        status: wasTruncated ? "partial" : "success",
        metadata: {
          kind: "search",
          path: root,
          pattern,
          matches: matches.length,
          truncated: wasTruncated,
          searchSignature: `glob:${root}:${pattern}`,
          searchFamily: `glob:${pattern}`,
        },
      };
    },
  };
}

async function walk(
  root: string,
  dir: string,
  matcher: (value: string) => boolean,
  files: Array<{ path: string; mtimeMs: number }>,
  truncated: { value: boolean },
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted || files.length >= MAX_RESULTS) {
    truncated.value = true;
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (abortSignal?.aborted || files.length >= MAX_RESULTS) {
      truncated.value = true;
      return;
    }
    if (entry.isDirectory() && DEFAULT_IGNORES.has(entry.name)) {
      continue;
    }

    const absolute = resolve(dir, entry.name);
    const rel = toPosix(relative(root, absolute));
    if (entry.isDirectory()) {
      await walk(root, absolute, matcher, files, truncated, abortSignal);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (matcher(rel)) {
      const info = await stat(absolute);
      files.push({ path: rel, mtimeMs: info.mtimeMs });
    }
  }
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

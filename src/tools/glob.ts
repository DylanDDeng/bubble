/**
 * Glob tool - discover files by path pattern without shell access.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import picomatch from "picomatch";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { isSensitivePath } from "./sensitive-paths.js";
import { expandHomePath, resolveToolPath } from "./path-utils.js";

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
    effect: "read",
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
      const requestedRoot = resolveToolPath(cwd, typeof args.path === "string" && args.path.trim() ? args.path : ".");
      const originalPattern = String(args.pattern || "").trim();
      if (!originalPattern) {
        return { content: "Error: glob pattern is required", isError: true, status: "command_error" };
      }
      const normalized = normalizeGlobSearch(requestedRoot, originalPattern);
      if (normalized.error) {
        return normalized.error;
      }

      const { root, pattern, normalizedPattern } = normalized;

      if (isSensitivePath(root)) {
        return {
          content: `Error: Glob blocked for sensitive credential storage: ${root}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            path: root,
            pattern: normalizedPattern,
            originalPattern,
            normalizedPattern,
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
      const absoluteMatches = matches.map((item) => resolve(root, item));
      const wasTruncated = truncated.value || files.length > MAX_RESULTS;

      if (matches.length === 0) {
        return {
          content: "No files found.",
          status: "no_match",
          metadata: {
            kind: "search",
            path: root,
            pattern: normalizedPattern,
            originalPattern,
            normalizedPattern,
            matches: 0,
            truncated: false,
            searchSignature: `glob:${root}:${normalizedPattern}`,
            searchFamily: `glob:${normalizedPattern}`,
            paths: [],
          },
        };
      }

      return {
        content: `${matches.join("\n")}${wasTruncated ? `\n[More than ${MAX_RESULTS} files, output truncated]` : ""}`,
        status: wasTruncated ? "partial" : "success",
        metadata: {
          kind: "search",
          path: root,
          pattern: normalizedPattern,
          originalPattern,
          normalizedPattern,
          matches: matches.length,
          truncated: wasTruncated,
          searchSignature: `glob:${root}:${normalizedPattern}`,
          searchFamily: `glob:${normalizedPattern}`,
          paths: absoluteMatches,
        },
      };
    },
  };
}

type NormalizedGlobSearch =
  | { root: string; pattern: string; normalizedPattern: string; error?: undefined }
  | { error: ToolResult };

function normalizeGlobSearch(requestedRoot: string, originalPattern: string): NormalizedGlobSearch {
  const expandedPattern = expandGlobPatternHome(originalPattern);
  const scan = picomatch.scan(expandedPattern);
  const prefix = scan.prefix ?? "";

  if (!isAbsolute(scan.base)) {
    if (escapesSearchRoot(scan.base)) {
      return {
        error: {
          content: `Error: Glob pattern must stay within the search path: ${originalPattern}`,
          isError: true,
          status: "command_error",
          metadata: {
            kind: "search",
            path: requestedRoot,
            pattern: originalPattern,
            originalPattern,
            normalizedPattern: originalPattern,
            reason: "pattern_outside_search_path",
          },
        },
      };
    }
    return { root: requestedRoot, pattern: originalPattern, normalizedPattern: originalPattern };
  }

  const absoluteBase = resolve(scan.base);
  const patternRoot = scan.isGlob ? absoluteBase : dirname(absoluteBase);
  const patternBody = scan.isGlob ? scan.glob : basename(absoluteBase);
  const normalizedRoot = isWithinSearchRoot(requestedRoot, patternRoot) ? requestedRoot : patternRoot;
  const relativeBase = toPosix(relative(normalizedRoot, patternRoot));
  const normalizedBody = [relativeBase, patternBody].filter(Boolean).join("/");
  const normalizedPattern = `${prefix}${normalizedBody}`;

  return {
    root: normalizedRoot,
    pattern: normalizedPattern,
    normalizedPattern,
  };
}

function expandGlobPatternHome(pattern: string): string {
  if (pattern.startsWith("!")) {
    return `!${expandHomePath(pattern.slice(1))}`;
  }
  return expandHomePath(pattern);
}

function escapesSearchRoot(base: string): boolean {
  const normalized = toPosix(base);
  return normalized === ".." || normalized.startsWith("../");
}

function isWithinSearchRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
    if (isSensitivePath(absolute)) {
      continue;
    }
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

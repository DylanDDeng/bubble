/**
 * Read tool - read file contents with truncation, dedup, and auto-pagination.
 */

import { constants, type Dirent } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { isSensitivePath } from "./sensitive-paths.js";
import type { LspService } from "../lsp/index.js";
import type { FileStateTracker, ReadHistoryEntry } from "./file-state.js";
import { resolveToolPath } from "./path-utils.js";

const MAX_LINES = 2500;
const MAX_BYTES = 256 * 1024;

const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The earlier read tool_result in this conversation is still current — refer to that instead of re-reading. If you need a different range, call read again with explicit offset/limit; if the file has actually changed, edit or write will refresh this cache automatically.";

const END_OF_FILE_STUB = (totalLines: number) =>
  `End of file reached. All ${totalLines} lines of this file have already been returned by previous read tool_results in this conversation. Refer to those results, or pass an explicit offset to re-read a specific range.`;

export function createReadTool(cwd: string, approval?: ApprovalController, lsp?: LspService, fileState?: FileStateTracker): ToolRegistryEntry {
  const localHistory = new Map<string, ReadHistoryEntry>();
  const getHistory = (path: string): ReadHistoryEntry | undefined =>
    fileState?.getReadHistory(path) ?? localHistory.get(path);
  const setHistory = (path: string, entry: ReadHistoryEntry): void => {
    if (fileState) fileState.setReadHistory(path, entry);
    else localHistory.set(path, entry);
  };

  return {
    name: "read",
    readOnly: true,
    effect: "read",
    description: `Read the contents of a file. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). For large files: either pass explicit offset/limit to target a range, or simply call read again — the tool auto-advances to the next page when the previous read was truncated and the file is unchanged.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file (relative or absolute)" },
        offset: { type: "number", description: "Line number to start from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    async execute(args): Promise<ToolResult> {
      const filePath = resolveToolPath(cwd, args.path);

      if (isSensitivePath(filePath)) {
        return {
          content: `Error: Access to sensitive credential storage is blocked: ${filePath}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            path: filePath,
            reason: "Sensitive credential storage is not readable from general-purpose tasks.",
          },
        };
      }

      if (approval) {
        const result = approval.checkRules({ tool: "Read", path: filePath, cwd });
        if (result.decision === "deny") {
          return {
            content: `Error: Read blocked by deny rule: ${result.rule?.source ?? "<unknown>"} (${filePath})`,
            isError: true,
          };
        }
      }

      try {
        await access(filePath, constants.R_OK);
      } catch (error: any) {
        return {
          content: await readFileNotFoundMessage(filePath, cwd, error),
          isError: true,
        };
      }

      const argOffset = typeof args.offset === "number" ? args.offset : undefined;
      const argLimit = typeof args.limit === "number" ? args.limit : undefined;

      let currentMtimeMs: number | undefined;
      try {
        currentMtimeMs = (await stat(filePath)).mtimeMs;
      } catch {
        currentMtimeMs = undefined;
      }

      const prior = getHistory(filePath);
      const sameArgs = prior !== undefined
        && prior.argOffset === argOffset
        && prior.argLimit === argLimit;
      const mtimeUnchanged = prior !== undefined
        && currentMtimeMs !== undefined
        && Math.floor(prior.mtimeMs) === Math.floor(currentMtimeMs);

      let effectiveOffset = argOffset !== undefined ? Math.max(0, argOffset - 1) : 0;
      let autoAdvanceNote: string | undefined;

      if (prior && sameArgs && mtimeUnchanged) {
        if (prior.truncated && argOffset === undefined) {
          const nextStart = prior.effectiveOffset + prior.returnedLines;
          if (nextStart >= prior.totalLines) {
            return {
              content: END_OF_FILE_STUB(prior.totalLines),
              status: "success",
              metadata: { kind: "read", path: filePath, dedup: "end_of_file" },
            };
          }
          effectiveOffset = nextStart;
          autoAdvanceNote =
            `[Auto-advanced from previous truncated read of ${filePath}. ` +
            `Showing lines ${effectiveOffset + 1}+ (file has ${prior.totalLines} lines). ` +
            `Pass an explicit offset/limit to override this auto-paging.]`;
        } else if (
          argOffset === undefined
          && prior.effectiveOffset > 0
          && !prior.truncated
        ) {
          return {
            content: END_OF_FILE_STUB(prior.totalLines),
            status: "success",
            metadata: { kind: "read", path: filePath, dedup: "end_of_file" },
          };
        } else {
          return {
            content: FILE_UNCHANGED_STUB,
            status: "success",
            metadata: { kind: "read", path: filePath, dedup: "unchanged" },
          };
        }
      }

      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const effectiveLimit = argLimit !== undefined ? argLimit : totalLines;

      let sliced = lines.slice(effectiveOffset, effectiveOffset + effectiveLimit);
      let truncated = false;

      if (sliced.length > MAX_LINES) {
        sliced = sliced.slice(0, MAX_LINES);
        truncated = true;
      }

      let result = sliced.join("\n");
      const byteLength = Buffer.byteLength(result, "utf-8");
      if (byteLength > MAX_BYTES) {
        result = Buffer.from(result, "utf-8").subarray(0, MAX_BYTES).toString("utf-8");
        truncated = true;
      }

      if (autoAdvanceNote) {
        result = `${autoAdvanceNote}\n${result}`;
      }
      if (truncated) {
        const lastLine = effectiveOffset + sliced.length;
        result += `\n[Output truncated at line ${lastLine} of ${totalLines}. Call read again on the same path to auto-advance to the next page, or pass explicit offset/limit.]`;
      }

      if (currentMtimeMs !== undefined) {
        setHistory(filePath, {
          argOffset,
          argLimit,
          effectiveOffset,
          effectiveLimit,
          returnedLines: sliced.length,
          totalLines,
          mtimeMs: currentMtimeMs,
          truncated,
        });
      }

      const isFullRead = effectiveOffset === 0
        && !truncated
        && effectiveOffset + effectiveLimit >= totalLines;
      if (isFullRead) {
        await fileState?.observe(filePath, "read", content).catch(() => undefined);
      }

      void lsp?.touchFile(filePath).catch(() => undefined);

      return {
        content: result,
        status: "success",
        metadata: {
          kind: "read",
          path: filePath,
          offset: effectiveOffset + 1,
          lines: sliced.length,
          total: totalLines,
          ...(autoAdvanceNote ? { autoAdvanced: true } : {}),
          ...(truncated ? { truncated: true } : {}),
        },
      };
    },
  };
}

async function readFileNotFoundMessage(filePath: string, cwd: string, error: any): Promise<string> {
  const message = [`Error: Cannot read file: ${filePath}`];
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code && code !== "ENOENT" && code !== "ENOTDIR") return message[0]!;

  const suggestions = await suggestReadPaths(filePath, cwd);
  if (suggestions.length === 1) {
    message.push(`Did you mean ${suggestions[0]}?`);
  } else if (suggestions.length > 1) {
    message.push("Did you mean one of these?");
    message.push(...suggestions.map((suggestion) => `- ${suggestion}`));
  }
  return message.join("\n");
}

async function suggestReadPaths(filePath: string, cwd: string): Promise<string[]> {
  const suggestions = new Set<string>();
  const underCwd = await suggestPathUnderCwd(filePath, cwd);
  if (underCwd) suggestions.add(underCwd);

  for (const suggestion of await suggestSimilarFiles(filePath)) {
    suggestions.add(suggestion);
  }

  return [...suggestions].slice(0, 5);
}

async function suggestPathUnderCwd(filePath: string, cwd: string): Promise<string | undefined> {
  const parent = dirname(cwd);
  const parentPrefix = parent.endsWith("/") ? parent : `${parent}/`;
  if (!filePath.startsWith(parentPrefix) || filePath === cwd || filePath.startsWith(`${cwd}/`)) {
    return undefined;
  }

  const candidate = join(cwd, relative(parent, filePath));
  try {
    const stats = await stat(candidate);
    return stats.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function suggestSimilarFiles(filePath: string): Promise<string[]> {
  const dir = dirname(filePath);
  const target = basename(filePath);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => {
      const score = similarFileScore(target, entry.name);
      return score === undefined ? undefined : { path: join(dir, entry.name), score };
    })
    .filter((entry): entry is { path: string; score: number } => entry !== undefined)
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .map((entry) => entry.path)
    .slice(0, 5);
}

function similarFileScore(target: string, candidate: string): number | undefined {
  if (candidate === target) return undefined;

  const targetExt = extname(target).toLowerCase();
  const candidateExt = extname(candidate).toLowerCase();
  const targetStem = basename(target, targetExt).toLowerCase();
  const candidateStem = basename(candidate, candidateExt).toLowerCase();

  if (!targetStem || !candidateStem) return undefined;

  if (
    candidateExt === targetExt &&
    (candidateStem.startsWith(`${targetStem}_`) || candidateStem.startsWith(`${targetStem}-`))
  ) {
    return 0;
  }
  if (candidateExt === targetExt && (candidateStem.startsWith(targetStem) || targetStem.startsWith(candidateStem))) {
    return 5;
  }
  if (candidateStem === targetStem) {
    return 10;
  }
  if (candidateStem.includes(targetStem) || targetStem.includes(candidateStem)) {
    return candidateExt === targetExt ? 15 : 20;
  }

  const distance = levenshteinDistance(targetStem, candidateStem, 3);
  if (distance <= 2) {
    return (candidateExt === targetExt ? 30 : 35) + distance;
  }

  return undefined;
}

function levenshteinDistance(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = current[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[b.length]!;
}

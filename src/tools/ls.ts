import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { resolveToolPath } from "./path-utils.js";
import { isSensitivePath } from "./sensitive-paths.js";

const DEFAULT_LIMIT = 500;
const MAX_BYTES = 50 * 1024;

/** A shallow directory listing: nested files never crowd out sibling directories. */
export function createLsTool(cwd: string): ToolRegistryEntry {
  return {
    name: "ls",
    readOnly: true,
    effect: "read",
    promptSnippet: "List directory contents, including hidden files and subdirectories",
    description: `List one directory, sorted alphabetically, including hidden entries. Directories end in '/', symbolic links in '@' (not followed). Defaults to ${DEFAULT_LIMIT} entries; increase limit for more. Output is capped at 50 KiB. Does not recurse.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default: cwd)" },
        limit: { type: "integer", description: "Positive maximum entries to return (default: 500)" },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const cancelled = (): ToolResult => ({ content: "Directory listing cancelled.", isError: true, status: "cancelled" });
      if (ctx.abortSignal?.aborted) return cancelled();
      const limit = args.limit ?? DEFAULT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        return { content: "Error: limit must be a positive integer", isError: true, status: "command_error" };
      }
      if (args.path !== undefined && typeof args.path !== "string") {
        return { content: "Error: path must be a string", isError: true, status: "command_error" };
      }
      const root = resolveToolPath(cwd, args.path?.trim() ? args.path : ".");
      if (isSensitivePath(root)) {
        return { content: `Error: Listing blocked for sensitive credential storage: ${root}`, isError: true, status: "blocked" };
      }
      try {
        const entries = await readdir(root, { withFileTypes: true });
        if (ctx.abortSignal?.aborted) return cancelled();
        entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
        const lines: string[] = [];
        const paths: string[] = [];
        let bytes = 0;
        let byteLimitReached = false;
        for (const entry of entries) {
          if (ctx.abortSignal?.aborted) return cancelled();
          if (lines.length >= limit) break;
          // Quote control characters so one entry always occupies one output line.
          const name = /[\u0000-\u001f\u007f]/.test(entry.name) ? JSON.stringify(entry.name) : entry.name;
          const suffix = entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : "";
          const line = name + suffix;
          const size = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
          if (bytes + size > MAX_BYTES) {
            byteLimitReached = true;
            break;
          }
          lines.push(line);
          paths.push(resolve(root, entry.name) + (entry.isDirectory() ? "/" : ""));
          bytes += size;
        }
        const truncated = lines.length < entries.length;
        const notice = !truncated ? "" : byteLimitReached
          ? `\n\n[Output truncated at 50 KiB: showing ${lines.length} of ${entries.length} entries. Use bash with ls/find to filter or page the listing.]`
          : `\n\n[Output truncated: showing ${lines.length} of ${entries.length} entries. Increase limit to see more.]`;
        return {
          content: (entries.length === 0 ? "(empty directory)" : lines.join("\n")) + notice,
          status: truncated ? "partial" : "success",
          metadata: { kind: "search", path: root, matches: lines.length, totalEntries: entries.length, truncated, paths },
        };
      } catch (error) {
        if (ctx.abortSignal?.aborted) return cancelled();
        return {
          content: `Error: Cannot list directory: ${root} (${error instanceof Error ? error.message : String(error)})`,
          isError: true,
          status: "command_error",
        };
      }
    },
  };
}

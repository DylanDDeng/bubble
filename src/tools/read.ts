/**
 * Read tool - read file contents with truncation.
 */

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { isSensitivePath } from "./sensitive-paths.js";

const MAX_LINES = 250;
const MAX_BYTES = 100 * 1024;

export function createReadTool(cwd: string, approval?: ApprovalController): ToolRegistryEntry {
  return {
    name: "read",
    readOnly: true,
    description: `Read the contents of a file. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
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
      const filePath = resolve(cwd, args.path);

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
      } catch {
        return { content: `Error: Cannot read file: ${filePath}`, isError: true };
      }

      let content = await readFile(filePath, "utf-8");

      const lines = content.split("\n");
      const offset = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
      const limit = typeof args.limit === "number" ? args.limit : lines.length;

      let sliced = lines.slice(offset, offset + limit);
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

      if (truncated) {
        result += `\n[Output truncated: exceeded ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB limit]`;
      }

      return {
        content: result,
        status: "success",
        metadata: {
          kind: "read",
          path: filePath,
        },
      };
    },
  };
}

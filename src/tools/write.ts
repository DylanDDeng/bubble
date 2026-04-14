/**
 * Write tool - create or overwrite files.
 */

import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

export interface WriteToolOptions {
  /** If true, refuse to overwrite existing files */
  refuseOverwrite?: boolean;
}

export function createWriteTool(cwd: string, options: WriteToolOptions = {}): ToolRegistryEntry {
  return {
    name: "write",
    description: `Write a file to disk. Creates parent directories if needed.${options.refuseOverwrite ? " Will not overwrite existing files." : ""}`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file (relative or absolute)" },
        content: { type: "string", description: "File contents" },
      },
      required: ["path", "content"],
    },
    async execute(args): Promise<ToolResult> {
      const filePath = resolve(cwd, args.path);

      if (options.refuseOverwrite) {
        try {
          await access(filePath, constants.F_OK);
          return {
            content: `Error: File already exists: ${filePath}. Use edit tool to modify existing files.`,
            isError: true,
          };
        } catch {
          // file doesn't exist, proceed
        }
      }

      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, "utf-8");
        return { content: `Wrote ${filePath}` };
      } catch (err: any) {
        return { content: `Error: ${err.message}`, isError: true };
      }
    },
  };
}

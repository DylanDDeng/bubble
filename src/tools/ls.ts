/**
 * Ls tool - list directory contents.
 */

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

export function createLsTool(cwd: string): ToolRegistryEntry {
  return {
    name: "ls",
    description: "List files and directories in a given path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (relative or absolute, default: cwd)" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const targetPath = args.path ? resolve(cwd, args.path) : cwd;

      try {
        const entries = await readdir(targetPath);
        const results: string[] = [];

        for (const entry of entries) {
          try {
            const s = await stat(resolve(targetPath, entry));
            const type = s.isDirectory() ? "d" : s.isFile() ? "f" : "?";
            results.push(`${type} ${entry}`);
          } catch {
            results.push(`? ${entry}`);
          }
        }

        return { content: results.join("\n") || "(empty directory)" };
      } catch (err: any) {
        return { content: `Error: ${err.message}`, isError: true };
      }
    },
  };
}

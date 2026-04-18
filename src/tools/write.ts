/**
 * Write tool - create or overwrite files.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

export interface WriteToolOptions {
  /** If true, refuse to overwrite existing files */
  refuseOverwrite?: boolean;
}

export function createWriteTool(
  cwd: string,
  options: WriteToolOptions = {},
  approval?: ApprovalController,
): ToolRegistryEntry {
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

      let existed = false;
      try {
        await readFile(filePath, "utf-8");
        existed = true;
      } catch {
        // new file
      }

      const gate = await gateToolAction(approval, {
        type: "write",
        path: filePath,
        content: args.content,
        fileExists: existed,
      });
      if (!gate.approved) return gate.result;

      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, "utf-8");
        const lineCount = args.content.split("\n").length;
        const verb = existed ? "Updated" : "Wrote";
        return { content: `${verb} ${lineCount} lines to ${filePath}` };
      } catch (err: any) {
        return { content: `Error: ${err.message}`, isError: true };
      }
    },
  };
}

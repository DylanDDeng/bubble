/**
 * Write tool - create or overwrite files.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { formatDiagnosticBlocks, type LspService } from "../lsp/index.js";

export interface WriteToolOptions {
  /** If true, refuse to overwrite existing files */
  refuseOverwrite?: boolean;
}

export function createWriteTool(
  cwd: string,
  options: WriteToolOptions = {},
  approval?: ApprovalController,
  lsp?: LspService,
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
      let oldContent = "";
      try {
        oldContent = await readFile(filePath, "utf-8");
        existed = true;
      } catch {
        // new file
      }
      const diff = createTwoFilesPatch(filePath, filePath, oldContent, args.content, "original", "modified", { context: 3 });

      const gate = await gateToolAction(approval, {
        type: "write",
        path: filePath,
        content: args.content,
        diff,
        fileExists: existed,
      });
      if (!gate.approved) return gate.result;

      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content, "utf-8");
        const lineCount = args.content.split("\n").length;
        const verb = existed ? "Updated" : "Wrote";
        let content = `${verb} ${lineCount} lines to ${filePath}`;
        if (lsp) {
          try {
            await lsp.touchFile(filePath, "document");
            content += formatDiagnosticBlocks(cwd, filePath, lsp.diagnostics());
          } catch {
            // LSP diagnostics should not turn a successful write into a failed tool call.
          }
        }
        return { content };
      } catch (err: any) {
        return { content: `Error: ${err.message}`, isError: true };
      }
    },
  };
}

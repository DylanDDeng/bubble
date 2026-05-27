/**
 * Write tool - create files or replace full file contents.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { formatDiagnosticBlocks, type LspService } from "../lsp/index.js";
import { isWithinWorkspace, type FileStateTracker } from "./file-state.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToolPath } from "./path-utils.js";

export type WriteToolOptions = Record<string, never>;

export function createWriteTool(
  cwd: string,
  _options: WriteToolOptions = {},
  approval?: ApprovalController,
  lsp?: LspService,
  fileState?: FileStateTracker,
): ToolRegistryEntry {
  return {
    name: "write",
    effect: "write_direct",
    requiresApproval: true,
    description:
      "Write content to a file. Creates parent directories as needed. If the file already exists, this replaces the full file; use edit for small targeted changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file (relative or absolute)" },
        content: { type: "string", description: "File contents" },
      },
      required: ["path", "content"],
    },
    async execute(args): Promise<ToolResult> {
      const filePath = resolveToolPath(cwd, args.path);

      if (!isWithinWorkspace(cwd, filePath)) {
        return {
          content: `Error: Write path is outside the workspace: ${filePath}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            path: filePath,
            reason: "Write path is outside the workspace.",
          },
        };
      }

      return withFileMutationQueue(filePath, async () => {
        let existed = false;
        let oldContent = "";
        try {
          oldContent = await readFile(filePath, "utf-8");
          existed = true;
        } catch {
          // New file.
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

        const changed = await changedSincePreview(filePath, existed, oldContent);
        if (changed) {
          return changedDuringApprovalResult(filePath, changed);
        }

        try {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, args.content, "utf-8");
          await fileState?.observe(filePath, "write", args.content).catch(() => undefined);
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
          return {
            content,
            status: "success",
            metadata: {
              kind: "write",
              path: filePath,
              fileExists: existed,
            },
          };
        } catch (err: any) {
          return { content: `Error: ${err.message}`, isError: true };
        }
      });
    },
  };
}

async function changedSincePreview(filePath: string, existed: boolean, oldContent: string): Promise<"changed" | "missing" | "created" | undefined> {
  try {
    const latest = await readFile(filePath, "utf-8");
    if (!existed) return "created";
    return latest === oldContent ? undefined : "changed";
  } catch {
    return existed ? "missing" : undefined;
  }
}

function changedDuringApprovalResult(filePath: string, reason: "changed" | "missing" | "created"): ToolResult {
  if (reason === "changed") {
    return {
      content:
        `Error: Cannot safely write ${filePath} because it changed while approval was pending.\n\n`
        + "Re-read the file and retry the write against the latest content.",
      isError: true,
      status: "blocked",
      metadata: {
        kind: "security",
        path: filePath,
        reason,
      },
    };
  }
  if (reason === "created") {
    return {
      content:
        `Error: Cannot safely write ${filePath} because it was created while approval was pending.\n\n`
        + "Re-read the file and retry the write against the latest content.",
      isError: true,
      status: "blocked",
      metadata: {
        kind: "security",
        path: filePath,
        reason,
      },
    };
  }
  return {
    content:
      `Error: Cannot safely write ${filePath} because it is missing now.\n\n`
      + "Check the path before retrying.",
    isError: true,
    status: "blocked",
    metadata: {
      kind: "security",
      path: filePath,
      reason,
    },
  };
}

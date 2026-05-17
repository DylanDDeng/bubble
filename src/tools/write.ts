/**
 * Write tool - create files or safely replace full file contents.
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

export interface WriteToolOptions {
  /** If true, existing files require overwrite=true plus a fresh agent-observed version. */
  refuseOverwrite?: boolean;
}

export function createWriteTool(
  cwd: string,
  options: WriteToolOptions = {},
  approval?: ApprovalController,
  lsp?: LspService,
  fileState?: FileStateTracker,
): ToolRegistryEntry {
  return {
    name: "write",
    effect: "write_direct",
    requiresApproval: true,
    description:
      "Write a file to disk. Creates parent directories if needed. For an existing file, use overwrite=true only for full-file replacement after the file has been read or modified in this session; use edit for small targeted changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file (relative or absolute)" },
        content: { type: "string", description: "File contents" },
        overwrite: {
          type: "boolean",
          description: "Set true only for full-file replacement of an existing file. Existing files must have been read or modified in this session.",
        },
      },
      required: ["path", "content"],
    },
    async execute(args): Promise<ToolResult> {
      const filePath = resolveToolPath(cwd, args.path);
      const overwrite = args.overwrite === true;

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

        if (existed && options.refuseOverwrite && !overwrite) {
          return {
            content:
              `Error: File already exists: ${filePath}.\n\n`
              + "For small targeted changes, use edit.\n"
              + "For a full-file replacement, call write again with overwrite=true. Existing files must be read or modified in this session before they can be safely overwritten.\n"
              + "Do not delete and recreate the file just to overwrite it.",
            isError: true,
          };
        }

        if (existed && overwrite && options.refuseOverwrite) {
          if (!fileState) {
            return {
              content:
                `Error: Cannot safely overwrite ${filePath} because file-state tracking is unavailable. `
                + "Read the file first in this agent session, then retry the full-file replacement.",
              isError: true,
              status: "blocked",
            };
          }
          const freshness = await fileState.checkFresh(filePath);
          if (!freshness.ok) {
            return staleOverwriteResult(filePath, freshness.reason);
          }
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

        if (existed && overwrite && options.refuseOverwrite && fileState) {
          const freshness = await fileState.checkFresh(filePath);
          if (!freshness.ok) {
            return staleOverwriteResult(filePath, freshness.reason);
          }
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
              overwrite,
            },
          };
        } catch (err: any) {
          return { content: `Error: ${err.message}`, isError: true };
        }
      });
    },
  };
}

function staleOverwriteResult(filePath: string, reason: "unobserved" | "missing" | "changed"): ToolResult {
  if (reason === "unobserved") {
    return {
      content:
        `Error: Cannot safely overwrite existing file: ${filePath}.\n\n`
        + "This file has not been read or modified in this agent session. Read it first, then retry write with overwrite=true.\n"
        + "For small targeted changes, use edit. Do not delete and recreate the file just to overwrite it.",
      isError: true,
      status: "blocked",
      metadata: {
        kind: "security",
        path: filePath,
        reason,
      },
    };
  }
  if (reason === "changed") {
    return {
      content:
        `Error: Cannot safely overwrite ${filePath} because it changed since the last read/write/edit in this agent session.\n\n`
        + "Re-read the file to pick up the latest content, then retry write with overwrite=true if a full-file replacement is still intended.",
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
      `Error: Cannot safely overwrite ${filePath} because it is missing now.\n\n`
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

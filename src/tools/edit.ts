/**
 * Edit tool - targeted string replacements with diff validation.
 *
 * This is the safest way to edit files: old_string must exist exactly once.
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { formatDiagnosticBlocks, type LspService } from "../lsp/index.js";
import { applyEditsToContent, EditApplyError, formatEditMatchNotes } from "./edit-apply.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";

export interface EditArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

function isWithinWorkspace(cwd: string, filePath: string): boolean {
  const rel = relative(resolve(cwd), filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createEditTool(cwd: string, approval?: ApprovalController, lsp?: LspService): ToolRegistryEntry {
  return {
    name: "edit",
    effect: "write_direct",
    requiresApproval: true,
    description:
      "Apply targeted string replacements to a file. Prefer exact oldText. The tool can tolerate line ending, trailing whitespace, Unicode punctuation/space, and blank-line differences only when the target is unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        edits: {
          type: "array",
          description: "List of replacements. Each oldText must be unique in the file.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace" },
              newText: { type: "string", description: "Replacement text" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
    async execute(args): Promise<ToolResult> {
      const filePath = resolve(cwd, args.path);

      if (!isWithinWorkspace(cwd, filePath)) {
        return {
          content: `Error: Edit path is outside the workspace: ${filePath}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            path: filePath,
            reason: "Edit path is outside the workspace.",
          },
        };
      }

      return withFileMutationQueue(filePath, async () => {
        try {
          await access(filePath, constants.R_OK | constants.W_OK);
        } catch {
          return { content: `Error: Cannot read/write file: ${filePath}`, isError: true };
        }

        const original = await readFile(filePath, "utf-8");
        let applied;
        try {
          applied = applyEditsToContent(original, args.edits);
        } catch (err) {
          if (err instanceof EditApplyError) {
            return { content: err.message, isError: true, status: err.status };
          }
          throw err;
        }

        const diff = createTwoFilesPatch(filePath, filePath, original, applied.content, "original", "modified", { context: 3 });

        // Gate on the approval controller BEFORE persisting the change.
        const gate = await gateToolAction(approval, {
          type: "edit",
          path: filePath,
          diff,
          fileExists: true,
        });
        if (!gate.approved) return gate.result;

        await writeFile(filePath, applied.content, "utf-8");

        let output = `Edited ${filePath}${formatEditMatchNotes(applied.matches)}\n\nDiff:\n${diff}`;
        if (lsp) {
          try {
            await lsp.touchFile(filePath, "document");
            output += formatDiagnosticBlocks(cwd, filePath, lsp.diagnostics());
          } catch {
            // LSP diagnostics should not turn a successful edit into a failed tool call.
          }
        }
        return {
          content: output,
          status: "success",
          metadata: {
            kind: "edit",
            path: filePath,
          },
        };
      });
    },
  };
}

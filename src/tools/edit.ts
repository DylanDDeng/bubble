/**
 * Edit tool - targeted string replacements with diff validation.
 *
 * This is the safest way to edit files: old_string must exist exactly once.
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import { countUnifiedDiffChanges } from "../diff-stats.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { formatDiagnosticBlocks, type LspService } from "../lsp/index.js";
import { applyEditsToContent, EditApplyError, formatEditMatchNotes } from "./edit-apply.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { isWithinWorkspace, type FileStateTracker } from "./file-state.js";
import { resolveToolPath } from "./path-utils.js";

export interface EditArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

function prepareEditArguments(input: Record<string, any>): Record<string, any> {
  if (!input || typeof input !== "object") return input;
  const args: Record<string, any> = { ...input };

  if (typeof args.file_path === "string" && typeof args.path !== "string") {
    args.path = args.file_path;
  }

  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // Keep the original value so validation surfaces the problem.
    }
  }

  if (Array.isArray(args.edits)) {
    args.edits = args.edits.map((edit) => {
      if (!edit || typeof edit !== "object") return edit;
      const normalized = { ...edit };
      if (typeof normalized.oldText !== "string") {
        normalized.oldText = firstString(edit.old_text, edit.oldString, edit.old_string);
      }
      if (typeof normalized.newText !== "string") {
        normalized.newText = firstString(edit.new_text, edit.newString, edit.new_string);
      }
      return normalized;
    });
  }

  if (!Array.isArray(args.edits)) {
    const oldText = firstString(args.oldText, args.old_text, args.oldString, args.old_string);
    const newText = firstString(args.newText, args.new_text, args.newString, args.new_string);
    if (typeof oldText === "string" && typeof newText === "string") {
      args.edits = [{ oldText, newText }];
    }
  }

  return args;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function createEditTool(cwd: string, approval?: ApprovalController, lsp?: LspService, fileState?: FileStateTracker): ToolRegistryEntry {
  return {
    name: "edit",
    effect: "write_direct",
    requiresApproval: true,
    description:
      "Edit a single file using targeted text replacements. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes overlap or one replacement is nested inside another, merge them into one edit. Do not include large unchanged regions just to connect distant changes.",
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes; each edits[].oldText must be copied verbatim from a fresh read of the current exact target block and must identify a unique target. Do not reconstruct oldText from memory, stale reads, or similar code elsewhere.",
      "When changing multiple small, clearly disjoint locations copied from the same fresh read, you may use one edit call with multiple entries in edits[]. Use separate smaller edit calls after re-reading when anchors are uncertain, stale, or likely to drift.",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits; merge only truly overlapping targets.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
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
    prepareArguments: prepareEditArguments,
    async execute(args): Promise<ToolResult> {
      if (!Array.isArray(args.edits)) {
        return {
          content: "Error: edit requires edits to be an array of { oldText, newText } replacements.",
          isError: true,
          status: "blocked",
          metadata: { kind: "edit", reason: "invalid_args" },
        };
      }
      for (let index = 0; index < args.edits.length; index++) {
        const edit = args.edits[index];
        if (!edit || typeof edit !== "object" || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
          return {
            content: `Error: edit requires edits[${index}] to contain string oldText and newText fields.`,
            isError: true,
            status: "blocked",
            metadata: { kind: "edit", reason: "invalid_args", index },
          };
        }
      }

      const filePath = resolveToolPath(cwd, args.path);

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
          applied = applyEditsToContent(original, args.edits, { path: filePath });
        } catch (err) {
          if (err instanceof EditApplyError) {
            return {
              content: err.message,
              isError: true,
              status: err.status,
              metadata: {
                kind: "edit",
                path: filePath,
                reason: err.status,
              },
            };
          }
          throw err;
        }

        const diff = createTwoFilesPatch(filePath, filePath, original, applied.content, "original", "modified", { context: 3 });
        const diffStats = countUnifiedDiffChanges(diff);

        // Gate on the approval controller BEFORE persisting the change.
        const gate = await gateToolAction(approval, {
          type: "edit",
          path: filePath,
          diff,
          fileExists: true,
        });
        if (!gate.approved) return gate.result;

        const latest = await readFile(filePath, "utf-8");
        if (latest !== original) {
          return {
            content:
              `Error: Cannot safely edit ${filePath} because it changed while approval was pending.\n\n`
              + "Re-read the file and retry the edit against the latest content.",
            isError: true,
            status: "blocked",
            metadata: {
              kind: "security",
              path: filePath,
              reason: "changed",
            },
          };
        }

        await writeFile(filePath, applied.content, "utf-8");
        await fileState?.observe(filePath, "edit", applied.content).catch(() => undefined);

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
            diff,
            addedLines: diffStats.added,
            removedLines: diffStats.removed,
          },
        };
      });
    },
  };
}

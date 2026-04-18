/**
 * Edit tool - targeted string replacements with diff validation.
 *
 * This is the safest way to edit files: old_string must exist exactly once.
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

export interface EditArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

export function createEditTool(cwd: string, approval?: ApprovalController): ToolRegistryEntry {
  return {
    name: "edit",
    description:
      "Apply targeted string replacements to a file. Each oldText must match exactly once. All edits apply to the original file contents simultaneously.",
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

      try {
        await access(filePath, constants.R_OK | constants.W_OK);
      } catch {
        return { content: `Error: Cannot read/write file: ${filePath}`, isError: true };
      }

      const original = await readFile(filePath, "utf-8");
      let content = original;

      const edits: Array<{ oldText: string; newText: string }> = args.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        return { content: "Error: No edits provided", isError: true };
      }

      // Validate each oldText exists exactly once
      for (const edit of edits) {
        const count = content.split(edit.oldText).length - 1;
        if (count === 0) {
          return {
            content: `Error: oldText not found in file: "${edit.oldText.slice(0, 50)}..."`,
            isError: true,
          };
        }
        if (count > 1) {
          return {
            content: `Error: oldText appears ${count} times in file. Must be unique: "${edit.oldText.slice(0, 50)}..."`,
            isError: true,
          };
        }
      }

      // Apply all edits in-memory to compute the proposed next content + diff.
      for (const edit of edits) {
        content = content.replace(edit.oldText, edit.newText);
      }
      const diff = createTwoFilesPatch(filePath, filePath, original, content, "original", "modified", { context: 3 });

      // Gate on the approval controller BEFORE persisting the change.
      const gate = await gateToolAction(approval, {
        type: "edit",
        path: filePath,
        diff,
        fileExists: true,
      });
      if (!gate.approved) return gate.result;

      await writeFile(filePath, content, "utf-8");

      return {
        content: `Edited ${filePath}\n\nDiff:\n${diff}`,
      };
    },
  };
}

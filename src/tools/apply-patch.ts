import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import { countUnifiedDiffChanges } from "../diff-stats.js";
import { formatDiagnosticBlocks, type LspService } from "../lsp/index.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { isWithinWorkspace, type FileStateTracker } from "./file-state.js";
import { withFileMutationQueues } from "./file-mutation-queue.js";
import { resolveToolPath } from "./path-utils.js";
import {
  applyPatchChunks,
  buildAddedFileContent,
  parseApplyPatch,
  PatchApplyError,
  type PatchFileOperation,
} from "./patch-apply.js";

export interface ApplyPatchArgs {
  patch?: string;
  patchText?: string;
}

interface FileState {
  path: string;
  originalContent: string | undefined;
  currentContent: string | undefined;
}

interface PlannedFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  oldContent: string | undefined;
  newContent: string | undefined;
  diff: string;
  addedLines: number;
  removedLines: number;
}

interface PatchPlan {
  changes: PlannedFileChange[];
  diff: string;
  paths: string[];
  fallbackCount: number;
}

export function createApplyPatchTool(
  cwd: string,
  approval?: ApprovalController,
  lsp?: LspService,
  fileState?: FileStateTracker,
): ToolRegistryEntry {
  return {
    name: "apply_patch",
    effect: "write_patch",
    requiresApproval: true,
    description:
      "Apply a structured patch for multi-file or larger changes. Use edit for small targeted replacements, write for full-file generation, and apply_patch for related adds/updates/deletes/moves.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "Patch text using *** Begin Patch / *** Add File / *** Update File / *** Delete File / *** End Patch markers.",
        },
        patchText: {
          type: "string",
          description: "Alias for patch; accepted for compatibility with other coding agents.",
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const patchText = typeof args.patch === "string"
        ? args.patch
        : typeof args.patchText === "string"
          ? args.patchText
          : "";
      if (!patchText.trim()) {
        return {
          content: "Error: apply_patch requires a non-empty patch string.",
          isError: true,
          status: "blocked",
        };
      }

      let operations: PatchFileOperation[];
      try {
        operations = parseApplyPatch(patchText).operations;
      } catch (err) {
        if (err instanceof PatchApplyError) {
          return { content: err.message, isError: true, status: err.status };
        }
        throw err;
      }

      const lockPaths = collectOperationPaths(cwd, operations);
      return withFileMutationQueues(lockPaths, async () => {
        let plan: PatchPlan;
        try {
          plan = await buildPatchPlan(cwd, operations);
        } catch (err) {
          if (err instanceof PatchApplyError) {
            return { content: err.message, isError: true, status: err.status };
          }
          throw err;
        }

        const gate = await gateToolAction(approval, {
          type: "patch",
          path: summarizePaths(plan.paths),
          paths: plan.paths,
          files: plan.changes.map((change) => ({ path: change.path, kind: change.kind })),
          diff: plan.diff,
        });
        if (!gate.approved) return gate.result;

        const stale = await checkPlanFresh(plan);
        if (stale) return stale;

        try {
          await writePatchPlan(plan);
        } catch (err) {
          await rollbackPatchPlan(plan).catch(() => undefined);
          return {
            content: `Error: apply_patch failed while writing files: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
            status: "partial",
            metadata: {
              kind: "patch",
              paths: plan.paths,
              diff: plan.diff,
            },
          };
        }

        await observePatchPlan(fileState, plan);

        let output = `Applied patch to ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}.`;
        if (plan.fallbackCount > 0) {
          output += ` ${plan.fallbackCount} hunk${plan.fallbackCount === 1 ? "" : "s"} used normalized matching.`;
        }
        if (lsp) {
          for (const change of plan.changes) {
            if (change.newContent === undefined) continue;
            try {
              await lsp.touchFile(change.path, "document");
              output += formatDiagnosticBlocks(cwd, change.path, lsp.diagnostics());
            } catch {
              // LSP diagnostics should not turn a successful patch into a failed tool call.
            }
          }
        }

        const totals = plan.changes.reduce(
          (acc, change) => ({
            added: acc.added + change.addedLines,
            removed: acc.removed + change.removedLines,
          }),
          { added: 0, removed: 0 },
        );
        return {
          content: output,
          status: "success",
          metadata: {
            kind: "patch",
            paths: plan.paths,
            diff: plan.diff,
            addedLines: totals.added,
            removedLines: totals.removed,
          },
        };
      });
    },
  };
}

async function buildPatchPlan(cwd: string, operations: PatchFileOperation[]): Promise<PatchPlan> {
  const states = new Map<string, FileState>();
  let fallbackCount = 0;

  const stateFor = async (path: string): Promise<FileState> => {
    const absolutePath = resolveToolPath(cwd, path);
    assertWorkspacePath(cwd, absolutePath);
    const existing = states.get(absolutePath);
    if (existing) return existing;

    const originalContent = await readExistingFile(absolutePath);
    const state: FileState = {
      path: absolutePath,
      originalContent,
      currentContent: originalContent,
    };
    states.set(absolutePath, state);
    return state;
  };

  for (const operation of operations) {
    if (operation.type === "add") {
      const state = await stateFor(operation.path);
      if (state.currentContent !== undefined) {
        throw new PatchApplyError(`Error: Cannot add ${operation.path}; file already exists.`, "blocked");
      }
      state.currentContent = buildAddedFileContent(operation.lines);
      continue;
    }

    if (operation.type === "delete") {
      const state = await stateFor(operation.path);
      if (state.currentContent === undefined) {
        throw new PatchApplyError(`Error: Cannot delete ${operation.path}; file does not exist.`, "blocked");
      }
      state.currentContent = undefined;
      continue;
    }

    const source = await stateFor(operation.path);
    if (source.currentContent === undefined) {
      throw new PatchApplyError(`Error: Cannot update ${operation.path}; file does not exist.`, "blocked");
    }
    let nextContent = source.currentContent;
    if (operation.chunks.length > 0) {
      const patched = applyPatchChunks(source.currentContent, operation.chunks, operation.path);
      nextContent = patched.content;
      if (patched.usedFallback) fallbackCount++;
    }

    if (operation.movePath) {
      const target = await stateFor(operation.movePath);
      if (target.path === source.path) {
        throw new PatchApplyError(`Error: Cannot move ${operation.path} to itself.`, "blocked");
      }
      if (target.currentContent !== undefined) {
        throw new PatchApplyError(`Error: Cannot move ${operation.path} to ${operation.movePath}; target already exists.`, "blocked");
      }
      source.currentContent = undefined;
      target.currentContent = nextContent;
    } else {
      source.currentContent = nextContent;
    }
  }

  const changes = [...states.values()]
    .filter((state) => state.originalContent !== state.currentContent)
    .map((state) => fileStateToChange(state));
  if (changes.length === 0) {
    throw new PatchApplyError("Error: Patch produced no file changes.", "blocked");
  }

  const diff = changes.map((change) => change.diff).join("\n");
  return {
    changes,
    diff,
    paths: changes.map((change) => change.path),
    fallbackCount,
  };
}

function fileStateToChange(state: FileState): PlannedFileChange {
  const oldContent = state.originalContent;
  const newContent = state.currentContent;
  const kind = oldContent === undefined
    ? "add"
    : newContent === undefined
      ? "delete"
      : "update";
  const diff = createTwoFilesPatch(state.path, state.path, oldContent ?? "", newContent ?? "", "original", "modified", { context: 3 });
  const stats = countUnifiedDiffChanges(diff);
  return {
    path: state.path,
    kind,
    oldContent,
    newContent,
    diff,
    addedLines: stats.added,
    removedLines: stats.removed,
  };
}

async function readExistingFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      throw new PatchApplyError(`Error: Cannot patch directory: ${path}`, "blocked");
    }
    await access(path, constants.R_OK | constants.W_OK);
    return await readFile(path, "utf-8");
  } catch (err) {
    if (err instanceof PatchApplyError) throw err;
    if (isMissingPathError(err)) return undefined;
    throw new PatchApplyError(`Error: Cannot read/write file for patch: ${path}`, "blocked");
  }
}

async function checkPlanFresh(plan: PatchPlan): Promise<ToolResult | undefined> {
  for (const change of plan.changes) {
    let current: string | undefined;
    try {
      current = await readExistingFile(change.path);
    } catch (err) {
      if (err instanceof PatchApplyError) {
        return { content: err.message, isError: true, status: err.status };
      }
      throw err;
    }
    if (current !== change.oldContent) {
      return {
        content:
          `Error: Cannot safely apply patch because ${change.path} changed after the patch was prepared.\n\n`
          + "Re-read the affected file and regenerate the patch against the latest content.",
        isError: true,
        status: "blocked",
        metadata: {
          kind: "patch",
          path: change.path,
          paths: plan.paths,
          reason: "changed",
        },
      };
    }
  }
  return undefined;
}

async function writePatchPlan(plan: PatchPlan): Promise<void> {
  for (const change of plan.changes) {
    if (change.newContent === undefined) continue;
    await mkdir(dirname(change.path), { recursive: true });
    await writeFile(change.path, change.newContent, "utf-8");
  }
  for (const change of plan.changes) {
    if (change.newContent !== undefined) continue;
    await rm(change.path, { force: true });
  }
}

async function rollbackPatchPlan(plan: PatchPlan): Promise<void> {
  for (const change of [...plan.changes].reverse()) {
    if (change.oldContent === undefined) {
      await rm(change.path, { force: true });
    } else {
      await mkdir(dirname(change.path), { recursive: true });
      await writeFile(change.path, change.oldContent, "utf-8");
    }
  }
}

async function observePatchPlan(fileState: FileStateTracker | undefined, plan: PatchPlan): Promise<void> {
  if (!fileState) return;
  await Promise.all(plan.changes.map(async (change) => {
    if (change.newContent === undefined) return;
    await fileState.observe(change.path, "edit", change.newContent).catch(() => undefined);
  }));
}

function collectOperationPaths(cwd: string, operations: PatchFileOperation[]): string[] {
  const paths: string[] = [];
  for (const operation of operations) {
    paths.push(resolveToolPath(cwd, operation.path));
    if (operation.type === "update" && operation.movePath) {
      paths.push(resolveToolPath(cwd, operation.movePath));
    }
  }
  return paths;
}

function assertWorkspacePath(cwd: string, filePath: string): void {
  if (!isWithinWorkspace(cwd, filePath)) {
    throw new PatchApplyError(`Error: Patch path is outside the workspace: ${filePath}`, "blocked");
  }
}

function summarizePaths(paths: string[]): string {
  if (paths.length === 1) return paths[0];
  return `${paths[0]} (+${paths.length - 1} more)`;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

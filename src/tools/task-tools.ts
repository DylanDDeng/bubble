/**
 * Deferred background-task tools (background-tasks design §2.1).
 *
 * Both are deferred: sessions that never background anything pay zero schema
 * cost. The bash spawn path unlocks them programmatically the moment the
 * first task exists, so there is no tool_search hop in practice.
 */

import type { ToolRegistryEntry, ToolResult } from "../types.js";
import type { BackgroundTaskInfo, ProcessManager } from "../tasks/manager.js";

const MAX_IDS_PER_CALL = 20;
const OUTPUT_TAIL_CHARS = 12000;

export function createBackgroundTaskTools(manager: ProcessManager): ToolRegistryEntry[] {
  return [
    {
      name: "task_output",
      deferred: true,
      readOnly: true,
      effect: "read",
      description:
        "Check background tasks started with bash run_in_background. Without wait_ms returns an immediate snapshot (status, elapsed, exit code, output tail). With wait_ms, blocks until the wait mode is satisfied or the deadline passes — a timeout is not an error; call again with a longer wait_ms. Never poll with foreground sleep; use wait_ms instead.",
      parameters: {
        type: "object",
        properties: {
          task_ids: {
            type: "array",
            items: { type: "string" },
            description: "Background task ids (task_XXXX). Max 20. Subagents use wait_agent; workflows use wait_workflow; servers use server_status.",
          },
          wait_ms: { type: "number", description: "Block up to this many milliseconds for completion. Omit for an immediate snapshot." },
          mode: { type: "string", enum: ["any", "all"], description: "With wait_ms: resolve when any (default) or all listed tasks finish." },
        },
        required: ["task_ids"],
        additionalProperties: false,
      },
      async execute(args): Promise<ToolResult> {
        const ids = normalizeIds(args.task_ids);
        if (!ids.length) {
          return { content: "Error: task_output requires at least one task id.", isError: true };
        }
        if (ids.length > MAX_IDS_PER_CALL) {
          return { content: `Error: task_output accepts at most ${MAX_IDS_PER_CALL} task ids per call.`, isError: true };
        }
        const unknown = ids.filter((id) => !manager.getTask(id));
        if (unknown.length) {
          return {
            content: `Error: unknown task id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Use ids returned by bash run_in_background.`,
            isError: true,
          };
        }

        const waitMs = typeof args.wait_ms === "number" && args.wait_ms > 0 ? args.wait_ms : undefined;
        const mode = args.mode === "all" ? "all" : "any";
        const tasks = waitMs !== undefined
          ? await manager.waitTasks(ids, { timeoutMs: waitMs, mode })
          : ids.map((id) => manager.getTask(id)!).filter(Boolean);

        const stillRunning = tasks.filter((task) => task.status === "running");
        const lines: string[] = [];
        if (waitMs !== undefined && stillRunning.length > 0) {
          lines.push(
            `task_output timed out after ${waitMs}ms with ${stillRunning.length} task(s) still running.`,
            "This is not a failure — call task_output again with a longer wait_ms instead of re-running the work.",
            "",
          );
        }
        for (const task of tasks) {
          lines.push(...formatTask(task, manager));
          lines.push("");
          // Reading a finished task counts as delivery (design §2.3a).
          if (task.status !== "running") manager.markTaskDelivered(task.id);
        }
        return {
          content: lines.join("\n").trim(),
          status: waitMs !== undefined && stillRunning.length > 0 ? "timeout" : "success",
          metadata: { kind: "shell", background: true },
        };
      },
    },
    {
      name: "kill_task",
      deferred: true,
      effect: "unknown",
      description:
        "Terminate a background task started with bash run_in_background (SIGTERM, then SIGKILL). Use only when the task is no longer needed or is misbehaving.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Background task id (task_XXXX)." },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
      async execute(args): Promise<ToolResult> {
        const id = String(args.task_id ?? "").trim();
        const existing = manager.getTask(id);
        if (!existing) {
          return { content: `Error: unknown task id: ${id || "(empty)"}.`, isError: true };
        }
        if (existing.status !== "running") {
          return {
            content: `Task ${id} already finished (${existing.status}${existing.exitCode != null ? `, exit ${existing.exitCode}` : ""}). Nothing to kill.`,
            status: "success",
            metadata: { kind: "shell", background: true },
          };
        }
        const killed = await manager.killTask(id);
        return {
          content: `Killed background task ${id}${killed?.description ? ` (${killed.description})` : ""}.`,
          status: "success",
          metadata: { kind: "shell", background: true },
        };
      },
    },
  ];
}

function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((value) => String(value).trim()).filter(Boolean);
  return [...new Set(ids)];
}

function formatTask(task: BackgroundTaskInfo, manager: ProcessManager): string[] {
  const elapsedMs = (task.endedAt ?? Date.now()) - task.startedAt;
  const elapsed = `${Math.round(elapsedMs / 1000)}s`;
  const header = task.status === "running"
    ? `${task.id}: running for ${elapsed}${task.description ? ` — ${task.description}` : ""}`
    : `${task.id}: ${task.status}${task.exitCode != null ? ` (exit ${task.exitCode})` : ""} in ${elapsed}${task.description ? ` — ${task.description}` : ""}`;
  const lines = [header, `  command: ${task.command}`];
  const output = manager.taskOutputTail(task.id, OUTPUT_TAIL_CHARS);
  if (output && output.trim()) {
    lines.push(`  output${task.outputTruncated ? " (tail, truncated)" : ""}:`);
    lines.push(...output.trimEnd().split("\n").map((line) => `    ${line}`));
  } else {
    lines.push("  output: (none captured)");
  }
  return lines;
}

/**
 * Background-task lifecycle reminder (background-tasks design §2.3a).
 *
 * Emission is STATE-CHANGE gated, never per-model-call: the reminder channel
 * is append-only (each injection is a persistent meta message that survives
 * pruning and compaction), so the caller compares the manager's task state
 * version and builds a reminder only when the owned task set changed since
 * the last emission. This mirrors the subagent lifecycle reminder's activity
 * gate rather than firing while tasks are merely alive.
 *
 * Because compaction preserves meta messages but drops session markers, this
 * reminder is also how the model recovers task ids after /compact.
 */

import type { BackgroundTaskInfo } from "../tasks/manager.js";

const OUTPUT_TAIL_CHARS = 2000;

export interface TaskReminderInput {
  tasks: BackgroundTaskInfo[];
  outputTail: (id: string) => string | undefined;
  /**
   * The task tools are already unlocked (the spawn path calls
   * unlockDeferredTools). When true the tool_search hint is dropped — field
   * test 2026-07-19 showed the unconditional hint makes the model burn a
   * tool_search call for tools it already has.
   */
  toolsAvailable?: boolean;
}

export function buildTaskLifecycleReminder({ tasks, outputTail, toolsAvailable }: TaskReminderInput): string | undefined {
  if (tasks.length === 0) return undefined;

  const running = tasks.filter((task) => task.status === "running");
  const finishedUndelivered = tasks.filter(
    (task) => task.status !== "running" && task.deliveredAt === undefined,
  );
  const finishedDelivered = tasks.filter(
    (task) => task.status !== "running" && task.deliveredAt !== undefined,
  );
  if (running.length === 0 && finishedUndelivered.length === 0 && finishedDelivered.length === 0) {
    return undefined;
  }

  const lines: string[] = ["Background task truth:"];
  for (const task of running) {
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    lines.push(`- running: ${task.id} (${label(task)}, ${elapsed}s elapsed)`);
  }
  for (const task of finishedUndelivered) {
    const elapsed = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
    lines.push(`- finished since last update: ${task.id} (${label(task)}) ${task.status}${task.exitCode != null ? ` exit ${task.exitCode}` : ""} in ${elapsed}s`);
    const tail = outputTail(task.id)?.trim();
    if (tail) {
      lines.push(`  output tail:`);
      lines.push(...clampTail(tail).split("\n").map((line) => `    ${line}`));
      lines.push("  Call task_output only if you need more of the output.");
    }
  }
  // Delivered final results already reached the model in full — id + status
  // only, never the output again (mirrors the subagent delivered demotion).
  for (const task of finishedDelivered) {
    lines.push(`- delivered: ${task.id} ${task.status}${task.exitCode != null ? ` (exit ${task.exitCode})` : ""}`);
  }
  lines.push(
    toolsAvailable
      ? "- Check tasks with task_output; stop them with kill_task. Both are already in your tool list — do NOT call tool_search for them."
      : "- Check tasks with task_output; stop them with kill_task (deferred: load via tool_search with query 'select:task_output,kill_task' if not yet available).",
  );
  lines.push("- Never re-run work a finished task already did; never poll with foreground sleep.");
  return lines.join("\n");
}

function label(task: BackgroundTaskInfo): string {
  return task.description?.trim() || truncate(task.command, 60);
}

function clampTail(tail: string): string {
  return tail.length <= OUTPUT_TAIL_CHARS ? tail : `…${tail.slice(-OUTPUT_TAIL_CHARS)}`;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

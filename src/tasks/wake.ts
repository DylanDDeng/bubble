/**
 * Auto-resume wake decision + coalescing (background-tasks design §2.3b).
 *
 * Kept pure and out of the TUI so the guard rails are unit-testable:
 * - debounce-before-fire coalescing (the idle input queue drains in ~0ms, so
 *   merging can only happen BEFORE the wake is submitted);
 * - user preemption (queued user input or a running turn suppresses the wake
 *   — the state-change reminder covers the completion on the next turn);
 * - config kill switch (tasks.auto_resume = false);
 * - killed tasks never wake (killing is an explicit decision, not news).
 */

import type { BackgroundTaskInfo } from "./manager.js";

export interface TaskWakeGateInput {
  autoResume: boolean;
  turnRunning: boolean;
  queuedInputs: number;
  exiting?: boolean;
}

export function shouldFireTaskWake(input: TaskWakeGateInput): boolean {
  if (!input.autoResume) return false;
  if (input.exiting) return false;
  if (input.turnRunning) return false;
  if (input.queuedInputs > 0) return false;
  return true;
}

export function taskEligibleForWake(task: BackgroundTaskInfo): boolean {
  return task.status === "completed" || task.status === "failed";
}

export function formatTaskWakeSummary(tasks: BackgroundTaskInfo[], outputTail: (id: string) => string | undefined): string {
  const lines: string[] = [
    tasks.length === 1
      ? "A background task you started has finished."
      : `${tasks.length} background tasks you started have finished.`,
  ];
  for (const task of tasks) {
    const elapsed = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
    lines.push(
      `- ${task.id}${task.description ? ` (${task.description})` : ""}: ${task.status}${task.exitCode != null ? ` exit ${task.exitCode}` : ""} in ${elapsed}s`,
    );
    lines.push(`  command: ${task.command}`);
    const tail = outputTail(task.id)?.trim();
    if (tail) {
      lines.push("  output tail:");
      lines.push(...tail.split("\n").slice(-30).map((line) => `    ${line}`));
    }
  }
  // Field-test lesson (2026-07-19): an unconditional "continue the work"
  // nudge pushed the model to invent follow-up work when nothing was left.
  lines.push(
    "If unfinished work depends on these results, continue it now. "
    + "If nothing does, report the outcome to the user in one or two sentences and stop — do not invent new work. "
    + "Never re-run what already finished.",
  );
  return lines.join("\n");
}

export interface DanglingTaskStart {
  id: string;
  pid?: number;
  startedAt?: number;
  command?: string;
  description?: string;
}

/**
 * Resume-time orphan detection (design §2.2c): task_started markers with no
 * matching task_finished/task_killed belong to a previous process. The caller
 * probes pid liveness before reporting.
 */
export function findDanglingTaskStarts(
  entries: Array<{ type: string; kind?: string; value?: string }>,
): DanglingTaskStart[] {
  const started = new Map<string, DanglingTaskStart>();
  for (const entry of entries) {
    if (entry.type !== "marker" || !entry.value) continue;
    if (entry.kind === "task_started") {
      const parsed = parseMarker(entry.value);
      if (parsed?.id) started.set(parsed.id, parsed);
    } else if (entry.kind === "task_finished" || entry.kind === "task_killed") {
      const parsed = parseMarker(entry.value);
      if (parsed?.id) started.delete(parsed.id);
    }
  }
  return [...started.values()];
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseMarker(value: string): DanglingTaskStart | undefined {
  try {
    const parsed = JSON.parse(value) as DanglingTaskStart;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Debounce-then-fire coalescer: the first eligible completion arms a timer;
 * completions inside the window fold into one wake payload.
 */
export class TaskWakeCoalescer {
  private pending: BackgroundTaskInfo[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly delayMs: number,
    private readonly fire: (tasks: BackgroundTaskInfo[]) => void,
  ) {}

  add(task: BackgroundTaskInfo): void {
    this.pending.push(task);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const tasks = this.pending.splice(0);
      if (tasks.length > 0) this.fire(tasks);
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Drop everything armed (session switch / exit). Returns what was pending. */
  cancel(): BackgroundTaskInfo[] {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.pending.splice(0);
  }
}

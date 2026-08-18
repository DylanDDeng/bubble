/**
 * Task/goal/loop runtime orchestration (controller extraction §5,
 * task-runtime-controller row).
 *
 * Owns the process-manager wiring from app.tsx:2220-2350:
 * - owner-session capture so task_started/finished markers land in the
 *   spawning session regardless of the currently bound one
 * - completion announcements for the current session
 * - wake coalescing with fire-time gates (running turn / queued input /
 *   exit suppress the wake; the state-change reminder carries it instead)
 * - held completions for non-current sessions replayed on switch-back
 * - loop scheduling (defer-not-stack) and goal continuation stay
 *   host-injected run launchers — this class only owns timing and gates.
 */
import type { BackgroundTaskInfo } from "../../tasks/manager.js";
import { TaskWakeCoalescer, shouldFireTaskWake, taskEligibleForWake, formatTaskWakeSummary } from "../../tasks/wake.js";

export interface TaskRuntimeDeps {
  readonly processManager: {
    listTasks(sessionFile?: string): BackgroundTaskInfo[];
    onChange(listener: (task: BackgroundTaskInfo) => void): () => void;
    onTaskFinished(listener: (task: BackgroundTaskInfo) => void): () => void;
    taskOutputTail(id: string, maxBytes: number): string;
    markTaskDelivered(id: string): void;
  };
  getSessionFile(): string | undefined;
  appendMarker(file: string, marker: string, payload: string): void;
  announceCompletion(task: BackgroundTaskInfo): void;
  /** Hidden task-wake submission (host wires to the run launcher). */
  submitTaskWake(summary: string): void;
  readonly tasksAutoResume: boolean;
  /** Live gates evaluated at wake-fire time. */
  gates(): { turnRunning: boolean; queuedInputs: number; exiting: boolean };
  readonly wakeDebounceMs?: number;
}

export class TaskRuntimeController {
  private readonly ownerSessions = new Map<string, string>();
  private readonly pendingCompletions = new Map<string, BackgroundTaskInfo[]>();
  private readonly wakeCoalescer: TaskWakeCoalescer;
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly deps: TaskRuntimeDeps) {
    this.wakeCoalescer = new TaskWakeCoalescer(
      deps.wakeDebounceMs ?? 500,
      (tasks) => this.fireWake(tasks),
    );
  }

  start(): void {
    this.unsubscribers.push(
      this.deps.processManager.onChange((task) => this.onTaskChange(task)),
      this.deps.processManager.onTaskFinished((task) => this.onTaskFinished(task)),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.wakeCoalescer.cancel();
  }

  snapshot(): BackgroundTaskInfo[] {
    return this.deps.processManager.listTasks(this.deps.getSessionFile());
  }

  /** Switch-back sweep: replay completions held for the now-current session. */
  releaseHeldCompletions(sessionFile: string): BackgroundTaskInfo[] {
    const held = this.pendingCompletions.get(sessionFile);
    if (!held?.length) return [];
    this.pendingCompletions.delete(sessionFile);
    for (const task of held) {
      this.deps.announceCompletion(task);
      if (taskEligibleForWake(task)) this.wakeCoalescer.add(task);
    }
    return held;
  }

  private onTaskChange(task: BackgroundTaskInfo): void {
    if (task.status !== "running" || this.ownerSessions.has(task.id)) return;
    const current = this.deps.getSessionFile();
    if (!current || task.ownerSessionId !== current) return;
    this.ownerSessions.set(task.id, current);
    this.deps.appendMarker(current, "task_started", JSON.stringify({
      id: task.id,
      pid: task.pid,
      startedAt: task.startedAt,
      command: task.command,
      description: task.description,
    }));
  }

  private onTaskFinished(task: BackgroundTaskInfo): void {
    const ownerFile = this.ownerSessions.get(task.id);
    if (ownerFile) {
      this.deps.appendMarker(ownerFile, task.status === "killed" ? "task_killed" : "task_finished", JSON.stringify({
        id: task.id,
        status: task.status,
        exitCode: task.exitCode ?? null,
        endedAt: task.endedAt,
      }));
      this.ownerSessions.delete(task.id);
    }

    const currentFile = this.deps.getSessionFile();
    if (task.ownerSessionId !== currentFile) {
      if (taskEligibleForWake(task) && task.ownerSessionId) {
        const held = this.pendingCompletions.get(task.ownerSessionId) ?? [];
        held.push(task);
        this.pendingCompletions.set(task.ownerSessionId, held);
      }
      return;
    }
    this.deps.announceCompletion(task);
    if (taskEligibleForWake(task)) this.wakeCoalescer.add(task);
  }

  private fireWake(tasks: BackgroundTaskInfo[]): void {
    if (this.disposed) return;
    const gates = this.deps.gates();
    if (!shouldFireTaskWake({
      autoResume: this.deps.tasksAutoResume !== false,
      turnRunning: gates.turnRunning,
      queuedInputs: gates.queuedInputs,
      exiting: gates.exiting,
    })) {
      return;
    }
    const summary = formatTaskWakeSummary(tasks, (id) => this.deps.processManager.taskOutputTail(id, 2000));
    for (const task of tasks) this.deps.processManager.markTaskDelivered(task.id);
    this.deps.submitTaskWake(summary);
  }
}

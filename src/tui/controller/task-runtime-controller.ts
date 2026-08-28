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
    getTask?(id: string): BackgroundTaskInfo | undefined;
    onChange(listener: (task: BackgroundTaskInfo) => void): () => void;
    onTaskFinished(listener: (task: BackgroundTaskInfo) => void): () => void;
    taskOutputTail(id: string, maxBytes: number): string | undefined;
    markTaskDelivered(id: string): void;
  };
  getSessionFile(): string | undefined;
  appendMarker(file: string, marker: string, payload: string): void;
  announceCompletion(task: BackgroundTaskInfo): void;
  /** Hidden task-wake submission (host wires to the run launcher). */
  submitTaskWake(summary: string): void;
  readonly tasksAutoResume: boolean;
  /** Live gates evaluated at wake-fire time. */
  gates(): { turnRunning: boolean; queuedInputs: number; exiting: boolean; goalActive?: boolean };
  readonly wakeDebounceMs?: number;
}

export class TaskRuntimeController {
  private readonly ownerSessions = new Map<string, string>();
  private readonly pendingCompletions = new Map<string, BackgroundTaskInfo[]>();
  private readonly deferredWake = new Map<string, BackgroundTaskInfo>();
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
    // A manager can already own a task when the renderer/controller is
    // recreated. Capture it exactly as a newly emitted running change.
    for (const task of this.deps.processManager.listTasks(this.deps.getSessionFile())) {
      this.onTaskChange(task);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.wakeCoalescer.cancel();
    this.deferredWake.clear();
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

  /** Re-evaluate completions that landed while a turn, queue, or Goal owned the loop. */
  onIdle(): void {
    if (this.deferredWake.size === 0) return;
    const tasks = [...this.deferredWake.values()];
    this.deferredWake.clear();
    this.fireWake(tasks);
  }

  /** Snapshot results that the next beforeTurn hook is expected to inject. */
  captureCurrentUndeliveredIds(): string[] {
    const current = this.deps.getSessionFile();
    return this.deps.processManager.listTasks(current)
      .filter((task) => taskEligibleForWake(task) && task.deliveredAt === undefined)
      .map((task) => task.id);
  }

  /** A provider turn_start confirms its beforeTurn hook accepted the snapshot. */
  markResultsDelivered(ids: readonly string[]): void {
    for (const id of ids) {
      const task = this.deps.processManager.getTask?.(id);
      if (task && taskEligibleForWake(task) && task.deliveredAt === undefined) {
        this.deps.processManager.markTaskDelivered(id);
      }
      this.deferredWake.delete(id);
    }
  }

  /** Persist tasks reaped after the UI controller has already stopped. */
  persistTerminalSnapshot(): void {
    for (const task of this.deps.processManager.listTasks()) {
      if (task.status !== "running") this.persistTerminalMarker(task);
    }
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
    this.persistTerminalMarker(task);

    const currentFile = this.deps.getSessionFile();
    if (task.ownerSessionId !== currentFile) {
      if (task.ownerSessionId) {
        const held = this.pendingCompletions.get(task.ownerSessionId) ?? [];
        if (!held.some((candidate) => candidate.id === task.id)) held.push(task);
        this.pendingCompletions.set(task.ownerSessionId, held);
      }
      return;
    }
    this.deps.announceCompletion(task);
    if (taskEligibleForWake(task)) this.wakeCoalescer.add(task);
  }

  private persistTerminalMarker(task: BackgroundTaskInfo): void {
    const ownerFile = this.ownerSessions.get(task.id);
    if (ownerFile) {
      this.deps.appendMarker(ownerFile, task.status === "killed" ? "task_killed" : "task_finished", JSON.stringify({
        id: task.id,
        status: task.status,
        exitCode: task.exitCode ?? null,
        command: task.command,
        description: task.description,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        outputLines: task.outputLines,
        output: this.deps.processManager.taskOutputTail(task.id, 12_000),
      }));
      this.ownerSessions.delete(task.id);
    }
  }

  private fireWake(tasks: BackgroundTaskInfo[]): void {
    if (this.disposed) return;
    if (this.deps.tasksAutoResume === false) return;
    const currentFile = this.deps.getSessionFile();
    const eligible = tasks
      .map((task) => this.deps.processManager.getTask?.(task.id) ?? task)
      .filter((task) => task.ownerSessionId === currentFile)
      .filter((task) => taskEligibleForWake(task) && task.deliveredAt === undefined);
    if (eligible.length === 0) return;
    const gates = this.deps.gates();
    if (!shouldFireTaskWake({
      autoResume: true,
      turnRunning: gates.turnRunning,
      queuedInputs: gates.queuedInputs,
      exiting: gates.exiting,
    }) || gates.goalActive) {
      if (!gates.exiting) {
        for (const task of eligible) this.deferredWake.set(task.id, task);
      }
      return;
    }
    const summary = formatTaskWakeSummary(eligible, (id) => this.deps.processManager.taskOutputTail(id, 2000));
    for (const task of eligible) {
      this.deps.processManager.markTaskDelivered(task.id);
      this.deferredWake.delete(task.id);
    }
    this.deps.submitTaskWake(summary);
  }
}

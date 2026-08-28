/**
 * Unified process manager: background tasks + managed servers
 * (docs/background-tasks-design.md §2.2).
 *
 * One registry owns every child process Bubble manages, discriminated by
 * `kind: "task" | "server"` — NOT `purpose`, which is a shipped model-facing
 * server field (preview|verification). Server semantics (port conflict scan,
 * readiness probe, lifecycle, lastUsedAt touch-on-read) are preserved
 * verbatim from the absorbed src/tools/server-manager.ts; that module remains
 * as a re-export shim so server tools, agent.ts, and their tests are
 * untouched.
 *
 * State is per-process (as the old server registry was). main.ts fetches the
 * instance via getProcessManager() and passes it explicitly to createAllTools
 * and the TUI App — the TUI bridge is subscription-based (onChange /
 * onTaskFinished), never a hidden import (design §2.2a).
 *
 * Task children are spawned detached (own process group, killable as a tree)
 * but NOT unref'd — unlike servers, a task must never outlive the parent
 * process, so the event loop keeps owning it (design §2.2a). Reaping is
 * three-layered (design §2.2b): graceful shutdownTasks() with escalation, a
 * SIGKILL-only path for signal handlers, and a process.once("exit") backstop.
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { platform } from "node:os";
import type { Readable } from "node:stream";
import { appendTailCapped, killProcessTree, stripAnsi, tail } from "./process-utils.js";

const MAX_LOG_BYTES = 96 * 1024;
const STOP_FORCE_AFTER_MS = 1000;
const MAX_RUNNING_TASKS_PER_SESSION = 8;
const MAX_FINISHED_TASKS = 20;

// ---------------------------------------------------------------------------
// Server types (moved verbatim from server-manager.ts)
// ---------------------------------------------------------------------------

export type ManagedServerPurpose = "preview" | "verification";
export type ManagedServerLifecycle = "auto" | "keep_alive";
export type ManagedServerStatus = "starting" | "ready" | "running" | "exited" | "failed" | "stopped";

export interface ManagedServerInfo {
  id: string;
  command: string;
  cwd: string;
  port?: number;
  url?: string;
  ownerSessionId?: string;
  ownerRunId?: string;
  purpose: ManagedServerPurpose;
  lifecycle: ManagedServerLifecycle;
  startedAt: number;
  lastUsedAt: number;
  status: ManagedServerStatus;
  pid?: number;
  exitCode?: number | null;
}

interface ManagedServerRecord extends ManagedServerInfo {
  kind: "server";
  child?: ChildProcessByStdio<null, Readable, Readable>;
  logs: string;
}

export interface StartManagedServerInput {
  command: string;
  cwd: string;
  port?: number;
  readinessUrl?: string;
  timeoutSec?: number;
  ownerSessionId?: string;
  ownerRunId?: string;
  purpose?: ManagedServerPurpose;
  lifecycle?: ManagedServerLifecycle;
}

// ---------------------------------------------------------------------------
// Task types (design §2.2)
// ---------------------------------------------------------------------------

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundTaskInfo {
  kind: "task";
  id: string;
  command: string;
  description?: string;
  cwd: string;
  pid?: number;
  status: BackgroundTaskStatus;
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
  outputTruncated: boolean;
  /** Total stdout/stderr lines observed, including lines no longer in the tail buffer. */
  outputLines: number;
  /** Wake fired or model read the task via task_output (design §2.3a). */
  deliveredAt?: number;
  ownerSessionId?: string;
}

interface BackgroundTaskRecord extends BackgroundTaskInfo {
  child?: ChildProcess;
  output: string;
  outputLineBreaks: number;
  outputHasData: boolean;
  outputEndsWithNewline: boolean;
}

export interface StartBackgroundTaskInput {
  command: string;
  description?: string;
  cwd: string;
  ownerSessionId?: string;
}

export interface AdoptBackgroundTaskInput extends StartBackgroundTaskInput {
  /** Already-running child handed over by Ctrl+B promotion (design §2.5). */
  child: ChildProcess;
  /** Output accumulated before promotion, seeds the ring buffer. */
  outputSoFar?: string;
  startedAt?: number;
}

export type TaskEventListener = (task: BackgroundTaskInfo) => void;

function countLineBreaks(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function logicalLineCount(lineBreaks: number, hasData: boolean, endsWithNewline: boolean): number {
  if (!hasData) return 0;
  return lineBreaks + (endsWithNewline ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ProcessManager {
  private readonly registry = new Map<string, ManagedServerRecord | BackgroundTaskRecord>();
  private nextServerId = 1;
  private nextTaskId = 1;
  /** Bumped on task start/finish/kill — the reminder's state-change gate (design §2.3a). */
  private taskStateVersion = 0;
  private readonly changeListeners = new Set<TaskEventListener>();
  private readonly finishListeners = new Set<TaskEventListener>();

  // -- tasks ----------------------------------------------------------------

  getTaskStateVersion(): number {
    return this.taskStateVersion;
  }

  startTask(input: StartBackgroundTaskInput): BackgroundTaskInfo {
    if (!existsSync(input.cwd)) {
      throw new Error(`Working directory does not exist: ${input.cwd}`);
    }
    const command = input.command.trim();
    if (!command) throw new Error("command is required");

    // Atomic reserve (design §2.2d): the cap check and record insertion are
    // synchronous with no await between them; spawn failures roll back below.
    this.reserveTaskSlot(input.ownerSessionId);

    const shell = platform() === "win32" ? "cmd.exe" : "bash";
    const shellArgs = platform() === "win32" ? ["/c", command] : ["-c", command];
    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd: input.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        detached: platform() !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    return this.registerTaskChild(child, { ...input, command });
  }

  /** Ctrl+B promotion: adopt a child the bash tool already spawned (§2.5). */
  adoptTask(input: AdoptBackgroundTaskInput): BackgroundTaskInfo {
    this.reserveTaskSlot(input.ownerSessionId);
    return this.registerTaskChild(input.child, input, {
      outputSoFar: input.outputSoFar,
      startedAt: input.startedAt,
    });
  }

  private reserveTaskSlot(ownerSessionId?: string): void {
    const running = this.taskRecords().filter(
      (task) => task.status === "running" && task.ownerSessionId === ownerSessionId,
    );
    if (running.length >= MAX_RUNNING_TASKS_PER_SESSION) {
      throw new Error(
        `Background task limit reached (${MAX_RUNNING_TASKS_PER_SESSION} running). `
        + "Wait for one to finish with task_output, or kill one with kill_task.",
      );
    }
  }

  private registerTaskChild(
    child: ChildProcess,
    input: StartBackgroundTaskInput,
    seed?: { outputSoFar?: string; startedAt?: number },
  ): BackgroundTaskInfo {
    const id = `task_${String(this.nextTaskId++).padStart(4, "0")}`;
    const seedOutput = seed?.outputSoFar ?? "";
    const seedLineBreaks = countLineBreaks(seedOutput);
    const record: BackgroundTaskRecord = {
      kind: "task",
      id,
      command: input.command,
      description: input.description,
      cwd: input.cwd,
      pid: child.pid,
      status: "running",
      startedAt: seed?.startedAt ?? Date.now(),
      output: seedOutput,
      outputTruncated: false,
      outputLines: logicalLineCount(seedLineBreaks, seedOutput.length > 0, seedOutput.endsWith("\n")),
      outputLineBreaks: seedLineBreaks,
      outputHasData: seedOutput.length > 0,
      outputEndsWithNewline: seedOutput.endsWith("\n"),
      ownerSessionId: input.ownerSessionId,
      child,
    };
    this.registry.set(id, record);

    const append = (data: Buffer) => {
      const chunk = data.toString();
      const before = record.output;
      record.output = appendTailCapped(record.output, chunk, MAX_LOG_BYTES);
      record.outputLineBreaks += countLineBreaks(chunk);
      if (chunk.length > 0) {
        record.outputHasData = true;
        record.outputEndsWithNewline = chunk.endsWith("\n");
      }
      record.outputLines = logicalLineCount(
        record.outputLineBreaks,
        record.outputHasData,
        record.outputEndsWithNewline,
      );
      if (!record.outputTruncated && before.length + data.length > record.output.length) {
        record.outputTruncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      append(Buffer.from(`\n[task failed to start: ${error.message}]\n`));
      this.finalizeTask(record, "failed", null);
    });
    child.once("exit", (code) => {
      if (record.status === "running") {
        this.finalizeTask(record, code === 0 ? "completed" : "failed", code);
      }
    });

    this.bumpTaskState(record);
    return this.publicTask(record);
  }

  private finalizeTask(record: BackgroundTaskRecord, status: BackgroundTaskStatus, exitCode: number | null): void {
    if (record.status !== "running") return;
    record.status = status;
    record.exitCode = exitCode;
    record.endedAt = Date.now();
    record.child = undefined;
    this.evictFinishedTasks();
    this.bumpTaskState(record);
    const snapshot = this.publicTask(record);
    for (const listener of this.finishListeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must never break task lifecycle.
      }
    }
  }

  getTask(id: string): BackgroundTaskInfo | undefined {
    const record = this.registry.get(id);
    if (!record || record.kind !== "task") return undefined;
    return this.publicTask(record);
  }

  listTasks(ownerSessionId?: string): BackgroundTaskInfo[] {
    return this.taskRecords()
      .filter((task) => ownerSessionId === undefined || task.ownerSessionId === ownerSessionId)
      .map((task) => this.publicTask(task));
  }

  taskOutputTail(id: string, maxChars = 12000): string | undefined {
    const record = this.registry.get(id);
    if (!record || record.kind !== "task") return undefined;
    // Single choke point for every task-output consumer (wake, reminder,
    // task_output tool, inspector): strip ANSI color noise before tailing.
    return tail(stripAnsi(record.output), maxChars);
  }

  markTaskDelivered(id: string): void {
    const record = this.registry.get(id);
    if (!record || record.kind !== "task") return;
    if (record.deliveredAt === undefined) {
      record.deliveredAt = Date.now();
      // Delivery suppresses duplicate Agent wakes, but the task inspector and
      // `y` copy action must retain the output for the complete UI lifecycle.
      // The existing 96KB-per-task cap and 20-task eviction bound memory.
    }
  }

  async waitTasks(
    ids: string[],
    options: { timeoutMs?: number; mode?: "any" | "all" } = {},
  ): Promise<BackgroundTaskInfo[]> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const mode = options.mode ?? "any";
    const wanted = new Set(ids);
    const satisfied = () => {
      const finished = ids.filter((id) => {
        const task = this.registry.get(id);
        return task?.kind === "task" && task.status !== "running";
      });
      return mode === "all" ? finished.length === wanted.size : finished.length > 0;
    };
    if (!satisfied() && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.finishListeners.delete(onFinish);
          clearTimeout(timer);
          resolve();
        };
        const onFinish = (task: BackgroundTaskInfo) => {
          if (wanted.has(task.id) && satisfied()) finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        timer.unref?.();
        this.finishListeners.add(onFinish);
      });
    }
    return ids
      .map((id) => this.getTask(id))
      .filter((task): task is BackgroundTaskInfo => task !== undefined);
  }

  async killTask(id: string): Promise<BackgroundTaskInfo | undefined> {
    const record = this.registry.get(id);
    if (!record || record.kind !== "task") return undefined;
    if (record.status !== "running") return this.publicTask(record);
    const pid = record.child?.pid ?? record.pid;
    // Mark first so the exit listener does not double-finalize as failed.
    this.finalizeTask(record, "killed", null);
    if (pid) {
      killProcessTree(pid, "SIGTERM");
      const forceTimer = setTimeout(() => killProcessTree(pid, "SIGKILL"), STOP_FORCE_AFTER_MS);
      forceTimer.unref?.();
    }
    return this.publicTask(record);
  }

  /** Graceful reaping for shutdownRuntime (design §2.2b layer 1). */
  async shutdownTasks(): Promise<void> {
    const running = this.taskRecords().filter((task) => task.status === "running");
    if (running.length === 0) return;
    for (const task of running) {
      const pid = task.child?.pid ?? task.pid;
      if (pid) killProcessTree(pid, "SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_FORCE_AFTER_MS));
    for (const task of running) {
      const pid = task.child?.pid ?? task.pid;
      if (pid) killProcessTree(pid, "SIGKILL");
      if (task.status === "running") this.finalizeTask(task, "killed", null);
    }
  }

  /** SIGKILL-only reaping for synchronous signal/exit paths (§2.2b layers 2-3). */
  reapTasksSync(): void {
    for (const task of this.taskRecords()) {
      if (task.status !== "running") continue;
      const pid = task.child?.pid ?? task.pid;
      if (pid) killProcessTree(pid, "SIGKILL");
      task.status = "killed";
      task.endedAt = Date.now();
      task.child = undefined;
    }
  }

  onTaskFinished(listener: TaskEventListener): () => void {
    this.finishListeners.add(listener);
    return () => this.finishListeners.delete(listener);
  }

  onChange(listener: TaskEventListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private bumpTaskState(record: BackgroundTaskRecord): void {
    this.taskStateVersion += 1;
    const snapshot = this.publicTask(record);
    for (const listener of this.changeListeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must never break task lifecycle.
      }
    }
  }

  private evictFinishedTasks(): void {
    const finished = this.taskRecords()
      .filter((task) => task.status !== "running")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    // Evict oldest DELIVERED first; fall back to oldest finished overall.
    while (finished.length > MAX_FINISHED_TASKS) {
      const victim = finished.find((task) => task.deliveredAt !== undefined) ?? finished[0]!;
      finished.splice(finished.indexOf(victim), 1);
      this.registry.delete(victim.id);
    }
  }

  private taskRecords(): BackgroundTaskRecord[] {
    return [...this.registry.values()].filter(
      (record): record is BackgroundTaskRecord => record.kind === "task",
    );
  }

  private publicTask(record: BackgroundTaskRecord): BackgroundTaskInfo {
    const {
      child: _child,
      output: _output,
      outputLineBreaks: _outputLineBreaks,
      outputHasData: _outputHasData,
      outputEndsWithNewline: _outputEndsWithNewline,
      ...info
    } = record;
    return { ...info };
  }

  // -- servers (moved verbatim from server-manager.ts, kind-filtered) --------

  async startManagedServer(input: StartManagedServerInput): Promise<ManagedServerInfo> {
    if (!existsSync(input.cwd)) {
      throw new Error(`Working directory does not exist: ${input.cwd}`);
    }
    const command = input.command.trim();
    if (!command) {
      throw new Error("command is required");
    }

    if (input.port !== undefined) {
      const managed = this.serverRecords().find((server) =>
        server.port === input.port && isActiveStatus(server.status));
      if (managed) {
        throw new Error(`Port ${input.port} is already managed by ${managed.id}. Stop it before starting another server.`);
      }
      if (await isPortOpen(input.port)) {
        throw new Error(`Port ${input.port} is already in use by an unmanaged process.`);
      }
    }

    const shell = platform() === "win32" ? "cmd.exe" : "bash";
    const shellArgs = platform() === "win32" ? ["/c", command] : ["-c", command];
    const child = spawn(shell, shellArgs, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: platform() !== "win32",
      windowsHide: true,
    });
    child.unref();
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    const now = Date.now();
    const id = `server_${String(this.nextServerId++).padStart(4, "0")}`;
    const readinessUrl = input.readinessUrl ?? (input.port ? `http://localhost:${input.port}` : undefined);
    const record: ManagedServerRecord = {
      kind: "server",
      id,
      command,
      cwd: input.cwd,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(readinessUrl ? { url: readinessUrl } : {}),
      ownerSessionId: input.ownerSessionId,
      ownerRunId: input.ownerRunId,
      purpose: input.purpose ?? "preview",
      lifecycle: input.lifecycle ?? "keep_alive",
      startedAt: now,
      lastUsedAt: now,
      status: "starting",
      pid: child.pid,
      child,
      logs: "",
    };
    this.registry.set(id, record);

    child.stdout.on("data", (data) => appendServerLog(record, data.toString()));
    child.stderr.on("data", (data) => appendServerLog(record, data.toString()));
    child.once("error", (error) => {
      record.status = "failed";
      appendServerLog(record, `\n[server failed: ${error.message}]\n`);
    });
    child.once("exit", (code) => {
      record.exitCode = code;
      if (record.status !== "stopped") {
        record.status = code === 0 ? "exited" : "failed";
      }
      record.child = undefined;
    });

    const timeoutSec = input.timeoutSec ?? 30;
    const ready = readinessUrl
      ? await waitForReadiness(record, readinessUrl, timeoutSec)
      : await waitForProcessToStayAlive(record, Math.min(timeoutSec, 2));
    if (!ready) {
      const logs = record.logs.trim();
      await this.stopManagedServer(id);
      throw new Error(`Server ${id} did not become ready within ${timeoutSec}s.${logs ? `\n\nLogs:\n${tail(logs, 4000)}` : ""}`);
    }

    record.status = readinessUrl ? "ready" : "running";
    record.lastUsedAt = Date.now();
    return publicServerInfo(record);
  }

  listManagedServers(): ManagedServerInfo[] {
    return this.serverRecords().map(publicServerInfo);
  }

  getManagedServer(id: string): ManagedServerInfo | undefined {
    const server = this.registry.get(id);
    if (!server || server.kind !== "server") return undefined;
    server.lastUsedAt = Date.now();
    return publicServerInfo(server);
  }

  getManagedServerLogs(id: string, maxChars = 12000): string | undefined {
    const server = this.registry.get(id);
    if (!server || server.kind !== "server") return undefined;
    server.lastUsedAt = Date.now();
    return tail(server.logs, maxChars);
  }

  async stopManagedServer(id: string): Promise<ManagedServerInfo | undefined> {
    const server = this.registry.get(id);
    if (!server || server.kind !== "server") return undefined;
    server.status = "stopped";
    server.lastUsedAt = Date.now();
    const child = server.child;
    if (child?.pid) {
      killProcessTree(child.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, STOP_FORCE_AFTER_MS));
      killProcessTree(child.pid, "SIGKILL");
    }
    server.child = undefined;
    return publicServerInfo(server);
  }

  async stopAutoServersForSession(sessionID?: string): Promise<void> {
    if (!sessionID) return;
    const owned = this.serverRecords().filter((server) =>
      server.ownerSessionId === sessionID && server.lifecycle === "auto" && isActiveStatus(server.status));
    await Promise.all(owned.map((server) => this.stopManagedServer(server.id)));
  }

  /** process.once("exit") backstop (§2.2b layer 3). */
  reapOnExit(): void {
    for (const record of this.registry.values()) {
      if (record.kind === "task") {
        if (record.status === "running") {
          const pid = record.child?.pid ?? record.pid;
          if (pid) killProcessTree(pid, "SIGKILL");
        }
        continue;
      }
      if (record.child?.pid && record.lifecycle !== "keep_alive") {
        killProcessTree(record.child.pid, "SIGKILL");
      }
    }
  }

  private serverRecords(): ManagedServerRecord[] {
    return [...this.registry.values()].filter(
      (record): record is ManagedServerRecord => record.kind === "server",
    );
  }
}

// ---------------------------------------------------------------------------
// Process-wide instance + compatibility surface
// ---------------------------------------------------------------------------

// One registry per process (exactly the scope the old module-level server Map
// had). main.ts passes this instance down explicitly; the server-manager shim
// delegates to it so existing imports keep working.
const defaultManager = new ProcessManager();

export function getProcessManager(): ProcessManager {
  return defaultManager;
}

export const startManagedServer = defaultManager.startManagedServer.bind(defaultManager);
export const listManagedServers = defaultManager.listManagedServers.bind(defaultManager);
export const getManagedServer = defaultManager.getManagedServer.bind(defaultManager);
export const getManagedServerLogs = defaultManager.getManagedServerLogs.bind(defaultManager);
export const stopManagedServer = defaultManager.stopManagedServer.bind(defaultManager);
export const stopAutoServersForSession = defaultManager.stopAutoServersForSession.bind(defaultManager);

process.once("exit", () => {
  defaultManager.reapOnExit();
});

// ---------------------------------------------------------------------------
// Server internals (moved verbatim)
// ---------------------------------------------------------------------------

function publicServerInfo(server: ManagedServerRecord): ManagedServerInfo {
  return {
    id: server.id,
    command: server.command,
    cwd: server.cwd,
    port: server.port,
    url: server.url,
    ownerSessionId: server.ownerSessionId,
    ownerRunId: server.ownerRunId,
    purpose: server.purpose,
    lifecycle: server.lifecycle,
    startedAt: server.startedAt,
    lastUsedAt: server.lastUsedAt,
    status: server.status,
    pid: server.pid,
    exitCode: server.exitCode,
  };
}

function appendServerLog(server: ManagedServerRecord, chunk: string): void {
  server.logs = appendTailCapped(server.logs, chunk, MAX_LOG_BYTES);
}

function unrefStream(stream: Readable): void {
  (stream as unknown as { unref?: () => void }).unref?.();
}

async function waitForReadiness(server: ManagedServerRecord, url: string, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (!isActiveStatus(server.status)) return false;
    if (await canFetch(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function waitForProcessToStayAlive(server: ManagedServerRecord, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (!isActiveStatus(server.status)) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return isActiveStatus(server.status);
}

async function canFetch(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isActiveStatus(status: ManagedServerStatus): boolean {
  return status === "starting" || status === "ready" || status === "running";
}

async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

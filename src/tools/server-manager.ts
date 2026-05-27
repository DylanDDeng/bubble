import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { platform } from "node:os";
import type { Readable } from "node:stream";

const MAX_LOG_BYTES = 96 * 1024;
const STOP_FORCE_AFTER_MS = 1000;

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

const servers = new Map<string, ManagedServerRecord>();
let nextServerId = 1;

export async function startManagedServer(input: StartManagedServerInput): Promise<ManagedServerInfo> {
  if (!existsSync(input.cwd)) {
    throw new Error(`Working directory does not exist: ${input.cwd}`);
  }
  const command = input.command.trim();
  if (!command) {
    throw new Error("command is required");
  }

  if (input.port !== undefined) {
    const managed = Array.from(servers.values()).find((server) =>
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
  const id = `server_${String(nextServerId++).padStart(4, "0")}`;
  const readinessUrl = input.readinessUrl ?? (input.port ? `http://localhost:${input.port}` : undefined);
  const record: ManagedServerRecord = {
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
  servers.set(id, record);

  child.stdout.on("data", (data) => appendLog(record, data.toString()));
  child.stderr.on("data", (data) => appendLog(record, data.toString()));
  child.once("error", (error) => {
    record.status = "failed";
    appendLog(record, `\n[server failed: ${error.message}]\n`);
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
    await stopManagedServer(id);
    throw new Error(`Server ${id} did not become ready within ${timeoutSec}s.${logs ? `\n\nLogs:\n${tail(logs, 4000)}` : ""}`);
  }

  record.status = readinessUrl ? "ready" : "running";
  record.lastUsedAt = Date.now();
  return publicInfo(record);
}

export function listManagedServers(): ManagedServerInfo[] {
  return Array.from(servers.values()).map(publicInfo);
}

export function getManagedServer(id: string): ManagedServerInfo | undefined {
  const server = servers.get(id);
  if (!server) return undefined;
  server.lastUsedAt = Date.now();
  return publicInfo(server);
}

export function getManagedServerLogs(id: string, maxChars = 12000): string | undefined {
  const server = servers.get(id);
  if (!server) return undefined;
  server.lastUsedAt = Date.now();
  return tail(server.logs, maxChars);
}

export async function stopManagedServer(id: string): Promise<ManagedServerInfo | undefined> {
  const server = servers.get(id);
  if (!server) return undefined;
  server.status = "stopped";
  server.lastUsedAt = Date.now();
  const child = server.child;
  if (child?.pid) {
    killProcessTree(child.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, STOP_FORCE_AFTER_MS));
    killProcessTree(child.pid, "SIGKILL");
  }
  server.child = undefined;
  return publicInfo(server);
}

export async function stopAutoServersForSession(sessionID?: string): Promise<void> {
  if (!sessionID) return;
  const owned = Array.from(servers.values()).filter((server) =>
    server.ownerSessionId === sessionID && server.lifecycle === "auto" && isActiveStatus(server.status));
  await Promise.all(owned.map((server) => stopManagedServer(server.id)));
}

function publicInfo(server: ManagedServerRecord): ManagedServerInfo {
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

function appendLog(server: ManagedServerRecord, chunk: string): void {
  server.logs += chunk;
  if (Buffer.byteLength(server.logs, "utf-8") > MAX_LOG_BYTES) {
    server.logs = Buffer.from(server.logs, "utf-8").subarray(-MAX_LOG_BYTES).toString("utf-8");
  }
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

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (platform() === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Process may already be gone.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

process.once("exit", () => {
  for (const server of servers.values()) {
    if (server.child?.pid && server.lifecycle !== "keep_alive") {
      killProcessTree(server.child.pid, "SIGKILL");
    }
  }
});

/**
 * Detect concurrent `bubble serve --feishu` instances for the same App ID.
 *
 * Two processes against the same App ID will fight over the long
 * connection and double-process messages. We record the running PID + appId
 * in `~/.bubble/feishu/processes.json` at startup and remove it at exit.
 *
 * On startup we check the file; any entry whose pid is still alive AND
 * whose appId matches is a conflict.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getProcessRegistryPath } from "./paths.js";
import type { ProcessRegistryEntry, ProcessRegistryFile } from "./types.js";

export interface ConflictInfo {
  entry: ProcessRegistryEntry;
}

export class ProcessRegistry {
  private file: ProcessRegistryFile;
  private path: string;

  constructor() {
    this.path = getProcessRegistryPath();
    this.file = this.read();
  }

  /** Return all entries whose pid is alive AND whose appId matches. */
  findConflicts(appId: string): ConflictInfo[] {
    return this.file.processes
      .filter((entry) => entry.appId === appId && isPidAlive(entry.pid))
      .map((entry) => ({ entry }));
  }

  /** Kill any conflicting entry's process (SIGTERM). Returns count killed. */
  killConflicts(appId: string): number {
    const conflicts = this.findConflicts(appId);
    let killed = 0;
    for (const c of conflicts) {
      try {
        process.kill(c.entry.pid, "SIGTERM");
        killed++;
      } catch {
        // process gone or no permission — fall through to next.
      }
    }
    this.gc();
    return killed;
  }

  /** Remove dead entries from disk. */
  gc(): void {
    this.file.processes = this.file.processes.filter((e) => isPidAlive(e.pid));
    this.flush();
  }

  register(entry: ProcessRegistryEntry): void {
    // Replace any existing entry for this pid.
    this.file.processes = this.file.processes.filter((e) => e.pid !== entry.pid);
    this.file.processes.push(entry);
    this.flush();
  }

  deregister(pid: number): void {
    this.file.processes = this.file.processes.filter((e) => e.pid !== pid);
    this.flush();
  }

  private read(): ProcessRegistryFile {
    if (!existsSync(this.path)) return { version: 1, processes: [] };
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as ProcessRegistryFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.processes)) {
        return { version: 1, processes: [] };
      }
      return parsed;
    } catch {
      return { version: 1, processes: [] };
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.file, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch {
      // Best effort.
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver but checks existence.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

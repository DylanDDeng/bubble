/**
 * Shared child-process mechanics for the unified process manager (background
 * tasks + managed servers) and the bash tool: process-tree kill with Windows
 * fallback, tail-keeping capped log buffers.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (platform() === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Process may already be gone or taskkill may be unavailable.
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

/** Keep the LAST maxBytes of a growing log (ring-buffer semantics). */
export function appendTailCapped(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf-8") <= maxBytes) return next;
  return Buffer.from(next, "utf-8").subarray(-maxBytes).toString("utf-8");
}

export function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

// Test runners color their output; raw escape sequences in a model-facing
// tail are token noise (observed with vitest in the first field test).
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

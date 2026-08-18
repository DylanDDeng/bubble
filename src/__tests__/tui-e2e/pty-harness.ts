/**
 * PTY-level e2e harness for the interactive TUI.
 *
 * Spawns the built CLI (`node dist/main.js`) inside a real pseudo-terminal
 * via node-pty, drives it with raw bytes, resizes mid-session, and asserts
 * on the emulated screen. This is the same class of test the Kimi/pi-tui
 * renderer suites use for production rendering bugs.
 *
 * Environment:
 *   BUBBLE_E2E_TUI_BIN  absolute path to the CLI to launch
 *                       (defaults to <repo>/dist/main.js)
 *
 * NOTE on node-pty + npm allowScripts: the packaged `spawn-helper` prebuild
 * can land without its executable bit on macOS. The harness repairs it
 * in-place at require time (one chmod) rather than failing mysteriously.
 */
import { chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// node-pty is a native devDependency; tolerate allowScripts stripping the
// executable bit from its bundled spawn-helper.
const spawnHelper = join(repoRoot, "node_modules/node-pty/prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
if (process.platform === "darwin" && existsSync(spawnHelper)) {
  try {
    chmodSync(spawnHelper, 0o755);
  } catch {
    // Non-fatal: fresh installs usually keep the bit.
  }
}

export interface PtySession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** All output emitted so far (raw, includes ANSI). */
  output(): string;
  /** Wait until `pattern` appears in the output, or fail after timeoutMs. */
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
}

export function tuiBinPath(): string {
  return process.env.BUBBLE_E2E_TUI_BIN ?? join(repoRoot, "dist/main.js");
}

export async function startTui(options: {
  cols?: number;
  rows?: number;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
} = {}): Promise<PtySession> {
  const pty = await import("node-pty");
  const cols = options.cols ?? 100;
  const rows = options.rows ?? 30;
  const bin = tuiBinPath();
  if (!existsSync(bin)) {
    throw new Error(`TUI binary not found at ${bin} — run npm run build first`);
  }

  const proc = pty.spawn(process.execPath, [bin, ...(options.args ?? [])], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      // Keep the harness hermetic: no user config, no real API keys.
      BUBBLE_HOME: join(repoRoot, ".e2e-tmp/bubble-home"),
      ...options.env,
    },
  });

  let buffered = "";
  proc.onData((chunk) => {
    buffered += chunk;
  });

  const session: PtySession = {
    write: (data) => proc.write(data),
    resize: (nextCols, nextRows) => proc.resize(nextCols, nextRows),
    kill: () => {
      try {
        proc.kill();
      } catch {
        // already dead
      }
    },
    output: () => buffered,
    waitFor: (pattern, timeoutMs = 10_000) =>
      new Promise<string>((resolvePromise, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (typeof pattern === "string" ? buffered.includes(pattern) : pattern.test(buffered)) {
            clearInterval(timer);
            resolvePromise(buffered);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(new Error(
              `Timed out waiting for ${String(pattern)}. Output so far (tail 800):\n${buffered.slice(-800)}`,
            ));
          }
        }, 30);
      }),
  };

  return session;
}

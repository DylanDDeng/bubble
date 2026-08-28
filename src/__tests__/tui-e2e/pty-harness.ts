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
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const XtermTerminal = xterm.Terminal;

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
  /** Current emulated terminal viewport, excluding scrollback history. */
  viewport(): string[];
  /** Wait until `pattern` appears in the output, or fail after timeoutMs. */
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  /** Wait until `pattern` is visible on the current emulated screen. */
  waitForViewport(pattern: string | RegExp, timeoutMs?: number): Promise<string[]>;
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

  const explicitBubbleHome = options.env?.BUBBLE_HOME;
  const bubbleHome = explicitBubbleHome ?? mkdtempSync(join(tmpdir(), "bubble-tui-e2e-"));
  const proc = pty.spawn(process.execPath, [bin, ...(options.args ?? [])], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      // Keep the harness hermetic: no user config, no real API keys.
      BUBBLE_HOME: bubbleHome,
      ...options.env,
    },
  });
  const screen = new XtermTerminal({
    cols,
    rows,
    allowProposedApi: true,
    disableStdin: true,
  });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    screen.dispose();
    if (!explicitBubbleHome) rmSync(bubbleHome, { recursive: true, force: true });
  };
  proc.onExit(cleanup);

  let buffered = "";
  proc.onData((chunk) => {
    buffered += chunk;
    screen.write(chunk);
  });

  const viewport = (): string[] => {
    const lines: string[] = [];
    const buffer = screen.buffer.active;
    for (let row = 0; row < screen.rows; row += 1) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }
    return lines;
  };

  const matches = (value: string, pattern: string | RegExp): boolean => {
    if (typeof pattern === "string") return value.includes(pattern);
    pattern.lastIndex = 0;
    return pattern.test(value);
  };

  const waitForMatch = <T>(
    read: () => { value: string; result: T },
    pattern: string | RegExp,
    timeoutMs: number,
    timeoutDetails: () => string,
  ): Promise<T> => new Promise<T>((resolvePromise, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const current = read();
      if (matches(current.value, pattern)) {
        clearInterval(timer);
        resolvePromise(current.result);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${String(pattern)}. ${timeoutDetails()}`));
      }
    }, 30);
  });

  const session: PtySession = {
    write: (data) => proc.write(data),
    resize: (nextCols, nextRows) => {
      screen.resize(nextCols, nextRows);
      proc.resize(nextCols, nextRows);
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        // already dead
      }
    },
    output: () => buffered,
    viewport,
    waitFor: (pattern, timeoutMs = 10_000) => waitForMatch(
      () => ({ value: buffered, result: buffered }),
      pattern,
      timeoutMs,
      () => `Output so far (tail 800):\n${buffered.slice(-800)}`,
    ),
    waitForViewport: (pattern, timeoutMs = 10_000) => waitForMatch(
      () => {
        const lines = viewport();
        return { value: lines.join("\n"), result: lines };
      },
      pattern,
      timeoutMs,
      () => `Current viewport:\n${viewport().join("\n")}`,
    ),
  };

  return session;
}

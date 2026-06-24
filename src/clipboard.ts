import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Cross-platform "copy text to the system clipboard" utility.
 *
 * Strategy: prefer native platform tools (pbcopy / clip / wl-copy / xclip /
 * xsel / termux-clipboard-set) via child_process, then layer an OSC 52
 * terminal escape on top for remote/multiplexed sessions where the native
 * clipboard is unreachable from the host running this process.
 *
 * Unlike pi's original implementation this deliberately avoids any native
 * addon dependency — Bubble must not add new npm deps — so it relies purely on
 * child_process + the OSC 52 fallback.
 */

type NativeClipboardExecOptions = {
  input: string;
  timeout: number;
  stdio: ["pipe", "ignore", "ignore"];
};

/**
 * Maximum length of the base64-encoded payload we are willing to emit via
 * OSC 52. Very large payloads can desynchronize terminal rendering and many
 * terminals silently drop sequences past ~100k, so we cap and skip instead.
 */
const MAX_OSC52_ENCODED_LENGTH = 100_000;

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
  try {
    execSync("xclip -selection clipboard", options);
  } catch {
    execSync("xsel --clipboard --input", options);
  }
}

/**
 * True when we appear to be running over SSH/Mosh, i.e. the host running this
 * process is not the machine whose clipboard the user is looking at.
 */
function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

/**
 * True when running inside a tmux session. tmux intercepts/relays terminal
 * clipboard escapes, so OSC 52 is the reliable path to reach the outer
 * terminal's clipboard (especially tmux-over-ssh). Native pbcopy still works
 * locally, so we treat this as "also emit OSC 52", never as a replacement.
 */
function isTmuxSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX);
}

/**
 * Build the OSC 52 escape sequence for the given text. Returns `null` when the
 * base64 payload exceeds {@link MAX_OSC52_ENCODED_LENGTH}.
 *
 * Format: ESC ] 52 ; c ; <base64> BEL  =>  `\x1b]52;c;<base64>\x07`
 *
 * Exported for unit testing the encoding/cap logic in isolation.
 */
export function encodeOsc52(text: string): string | null {
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
    return null;
  }
  return `\x1b]52;c;${encoded}\x07`;
}

/**
 * Write the OSC 52 sequence to stdout. Returns false (without writing) when the
 * payload is too large to emit safely.
 */
function emitOsc52(text: string): boolean {
  const sequence = encodeOsc52(text);
  if (sequence === null) {
    return false;
  }
  process.stdout.write(sequence);
  return true;
}

/**
 * Copy `text` to the system clipboard. Resolves once a copy path succeeds and
 * throws only when no path (native tools nor OSC 52) could place the text.
 */
export async function copyToClipboard(text: string): Promise<void> {
  let copied = false;

  const p = platform();
  const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

  try {
    if (p === "darwin") {
      execSync("pbcopy", options);
      copied = true;
    } else if (p === "win32") {
      execSync("clip", options);
      copied = true;
    } else {
      // Linux/other. Try Termux, Wayland, then X11 clipboard tools.
      if (process.env.TERMUX_VERSION) {
        try {
          execSync("termux-clipboard-set", options);
          copied = true;
        } catch {
          // Fall back to Wayland or X11 tools.
        }
      }

      if (!copied) {
        const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
        const hasX11Display = Boolean(process.env.DISPLAY);
        if (hasWaylandDisplay) {
          try {
            // Verify wl-copy exists (spawn errors are async and won't be caught).
            execSync("which wl-copy", { stdio: "ignore" });
            // wl-copy with execSync hangs due to fork behavior; use spawn instead.
            const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
            proc.stdin.on("error", () => {
              // Ignore EPIPE errors if wl-copy exits early.
            });
            proc.stdin.write(text);
            proc.stdin.end();
            proc.unref();
            copied = true;
          } catch {
            if (hasX11Display) {
              copyToX11Clipboard(options);
              copied = true;
            }
          }
        } else if (hasX11Display) {
          copyToX11Clipboard(options);
          copied = true;
        }
      }
    }
  } catch {
    // Fall through to the OSC 52 fallback.
  }

  // Emit OSC 52 when the native clipboard may be unreachable from this host
  // (remote sessions, tmux relaying to an outer terminal) or when no native
  // tool succeeded. This is additive — never throw if a native copy worked.
  if (isRemoteSession() || isTmuxSession() || !copied) {
    const osc52Copied = emitOsc52(text);
    copied = copied || osc52Copied;
  }

  if (!copied) {
    throw new Error("Failed to copy to clipboard");
  }
}

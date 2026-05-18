/**
 * Detect whether the host terminal is using a light or dark background so we
 * can pick a sensible default palette when the user has theme set to "auto".
 *
 * Resolution order:
 *   1. `COLORFGBG` env var — synchronous, set by VTE-family terminals (GNOME
 *      Terminal, Konsole) and iTerm2 (when enabled). Format is "fg;bg" or
 *      "fg;aux;bg" with each value being an ANSI color index 0–15.
 *   2. OSC 11 query — write `ESC ] 11 ; ? BEL`, listen on stdin for a reply
 *      shaped like `ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL`. Capped at ~150 ms so
 *      we don't stall startup on terminals that swallow the query.
 *   3. Fallback to "dark" — most coding terminals are dark, so this is the
 *      least surprising default when detection fails.
 *
 * Must run BEFORE Ink's `render()` takes over stdin. Ink puts stdin into raw
 * mode and consumes input itself, so the OSC 11 reply would never reach us.
 */

import type { ResolvedTheme } from "./theme.js";

export async function detectTerminalTheme(
  timeoutMs = 150,
): Promise<ResolvedTheme> {
  const fromEnv = parseColorFgBg(process.env.COLORFGBG);
  if (fromEnv) return fromEnv;

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const fromOsc = await queryOsc11(timeoutMs);
    if (fromOsc) return fromOsc;
  }

  return "dark";
}

/**
 * COLORFGBG examples:
 *   "15;0"     → bright-white fg on black bg → dark
 *   "0;15"     → black fg on bright-white bg → light
 *   "15;default;0" → some terminals add a default-bg sentinel in the middle.
 *
 * ANSI indices 0–6 are typically dark (black, red, green, yellow, blue,
 * magenta, cyan); 7–15 are typically light (gray-to-white-ish). 7 itself
 * (white) is ambiguous on some terminals but more often points to light.
 */
function parseColorFgBg(value: string | undefined): ResolvedTheme | null {
  if (!value) return null;
  const parts = value.split(";");
  const last = parts[parts.length - 1];
  if (!last) return null;
  const bg = parseInt(last, 10);
  if (Number.isNaN(bg)) return null;
  if (bg >= 0 && bg <= 6) return "dark";
  if (bg >= 7 && bg <= 15) return "light";
  return null;
}

function queryOsc11(timeoutMs: number): Promise<ResolvedTheme | null> {
  return new Promise<ResolvedTheme | null>((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let settled = false;
    const originalRaw = stdin.isRaw;
    let buffer = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(originalRaw);
      } catch {
        // ignore — terminal may have already restored
      }
      stdin.pause();
    };

    const finish = (result: ResolvedTheme | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // Match `ESC ] 11 ; rgb:RRRR/GGGG/BBBB ST` where ST is BEL (\x07) or
      // ESC \\. Some terminals reply with shorter hex (rgb:rr/gg/bb).
      const match = buffer.match(
        /\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)(?:\x07|\x1b\\)/,
      );
      if (!match) return;
      const [, r, g, b] = match;
      const lum = relativeLuminance(parseHexChannel(r), parseHexChannel(g), parseHexChannel(b));
      finish(lum > 0.5 ? "light" : "dark");
    };

    try {
      stdin.setRawMode(true);
    } catch {
      resolve(null);
      return;
    }
    stdin.resume();
    stdin.on("data", onData);

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      stdout.write("\x1b]11;?\x07");
    } catch {
      finish(null);
    }
  });
}

/** Normalize a hex channel string of arbitrary length to a 0–1 float. */
function parseHexChannel(hex: string): number {
  const max = (1 << (hex.length * 4)) - 1;
  return parseInt(hex, 16) / max;
}

/**
 * sRGB relative luminance per WCAG 2.x. Output range is 0 (black) to 1 (white).
 * We treat ≥ 0.5 as "light"; the actual threshold is forgiving because real
 * terminal backgrounds tend to be near-pure black (≈0.0) or near-pure white
 * (≈1.0).
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// SGR mouse reporting (button tracking + SGR encoding) so wheel events reach
// useInput as parseable \x1b[<64;…M sequences. While reporting is on, the
// terminal routes drags to the app instead of doing native text selection —
// the app exposes a selection mode that temporarily disables it.
export const MOUSE_REPORTING_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_REPORTING_DISABLE = "\x1b[?1006l\x1b[?1000l";

export function setMouseReporting(enabled: boolean): void {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write(enabled ? MOUSE_REPORTING_ENABLE : MOUSE_REPORTING_DISABLE);
  } catch {
    // stdout may already be destroyed during shutdown
  }
}

const SGR_MOUSE_SEQUENCE_RE = /\x1b?\[?<\d+;\d+;\d+[mM]/g;
const SGR_MOUSE_WHEEL_RE = /\x1b?\[?<(\d+);\d+;\d+([mM])/g;

export type MouseWheelDirection = "up" | "down";

export function stripTerminalMouseSequences(input: string): string {
  return input.replace(SGR_MOUSE_SEQUENCE_RE, "");
}

export function hasTerminalMouseSequence(input: string): boolean {
  SGR_MOUSE_SEQUENCE_RE.lastIndex = 0;
  return SGR_MOUSE_SEQUENCE_RE.test(input);
}

export function parseTerminalMouseWheel(input: string): MouseWheelDirection[] {
  const directions: MouseWheelDirection[] = [];
  SGR_MOUSE_WHEEL_RE.lastIndex = 0;
  for (const match of input.matchAll(SGR_MOUSE_WHEEL_RE)) {
    if (match[2] !== "M") continue;
    const code = Number(match[1]);
    if (code === 64) directions.push("up");
    if (code === 65) directions.push("down");
  }
  return directions;
}

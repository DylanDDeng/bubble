// Bubble does NOT enable mouse reporting — plain drag-select and copy keep
// their native terminal behavior. This disable sequence is written
// defensively on teardown in case a previous crash left reporting on.
export const MOUSE_REPORTING_DISABLE = "\x1b[?1006l\x1b[?1000l";

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

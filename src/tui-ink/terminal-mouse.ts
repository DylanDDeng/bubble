// Use normal mouse tracking + SGR encoding so wheel events reach the app as
// mouse reports instead of being translated into indistinguishable Up/Down
// keypresses by terminal alternate-scroll mode.
export const MOUSE_REPORTING_ENABLE = "\x1b[?1000h\x1b[?1006h";
// Disable every common tracking mode defensively in case a crash or another
// renderer left the terminal in a reporting state.
export const MOUSE_REPORTING_DISABLE = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1005l\x1b[?1006l\x1b[?1015l";

const ESCAPED_MOUSE_SEQUENCE_RE = /\x1b(?:\[<(\d+);\d+;\d+([mM])|\[M([\s\S])[\s\S]{2})/g;
const RAW_SGR_MOUSE_SEQUENCE_RE = /\[?<(\d+);\d+;\d+([mM])/g;
const RAW_SGR_MOUSE_INPUT_RE = /^(?:\[?<\d+;\d+;\d+[mM])+$/;

export type MouseWheelDirection = "up" | "down";

export interface TerminalMouseInput {
  strippedInput: string;
  wheelDirections: MouseWheelDirection[];
  hasMouse: boolean;
}

function wheelDirectionFromButtonCode(code: number): MouseWheelDirection | undefined {
  if ((code & 64) !== 64) return undefined;
  const wheelButton = code & 0b11;
  if (wheelButton === 0) return "up";
  if (wheelButton === 1) return "down";
  return undefined;
}

function collectWheelDirection(
  directions: MouseWheelDirection[],
  code: number,
  final: string | undefined,
): void {
  if (final !== undefined && final !== "M") return;
  const direction = wheelDirectionFromButtonCode(code);
  if (direction) directions.push(direction);
}

export function sanitizeTerminalMouseInput(input: string): TerminalMouseInput {
  const wheelDirections: MouseWheelDirection[] = [];
  let hasMouse = false;
  ESCAPED_MOUSE_SEQUENCE_RE.lastIndex = 0;
  let strippedInput = input.replace(
    ESCAPED_MOUSE_SEQUENCE_RE,
    (_sequence, sgrCode: string | undefined, sgrFinal: string | undefined, x10Button: string | undefined) => {
      hasMouse = true;
      const code = sgrCode !== undefined
        ? Number(sgrCode)
        : (x10Button?.charCodeAt(0) ?? 32) - 32;
      collectWheelDirection(wheelDirections, code, sgrFinal);
      return "";
    },
  );
  if (RAW_SGR_MOUSE_INPUT_RE.test(strippedInput)) {
    hasMouse = true;
    RAW_SGR_MOUSE_SEQUENCE_RE.lastIndex = 0;
    strippedInput = strippedInput.replace(
      RAW_SGR_MOUSE_SEQUENCE_RE,
      (_sequence, sgrCode: string, sgrFinal: string) => {
        collectWheelDirection(wheelDirections, Number(sgrCode), sgrFinal);
        return "";
      },
    );
  }
  return { strippedInput, wheelDirections, hasMouse };
}

export function transcriptScrollLinesFromMouseInput(
  mouseInput: TerminalMouseInput,
  options: { overlayActive: boolean },
): number[] {
  if (options.overlayActive) return [];
  return mouseInput.wheelDirections.map((direction) => direction === "up" ? -1 : 1);
}

export function stripTerminalMouseSequences(input: string): string {
  return sanitizeTerminalMouseInput(input).strippedInput;
}

export function hasTerminalMouseSequence(input: string): boolean {
  ESCAPED_MOUSE_SEQUENCE_RE.lastIndex = 0;
  return ESCAPED_MOUSE_SEQUENCE_RE.test(input) || RAW_SGR_MOUSE_INPUT_RE.test(input);
}

export function parseTerminalMouseWheel(input: string): MouseWheelDirection[] {
  return sanitizeTerminalMouseInput(input).wheelDirections;
}

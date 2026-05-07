import { isEscapeSequence } from "./prompt-keybindings.js";

export function normalizeKeyName(name?: string): string {
  const rawName = String(name || "").toLowerCase();
  if (["arrowleft", "left_arrow", "leftarrow", "cursorleft", "left"].includes(rawName)) return "left";
  if (["arrowright", "right_arrow", "rightarrow", "cursorright", "right"].includes(rawName)) return "right";
  if (["arrowup", "up_arrow", "uparrow", "cursorup", "up"].includes(rawName)) return "up";
  if (["arrowdown", "down_arrow", "downarrow", "cursordown", "down"].includes(rawName)) return "down";
  if (rawName === "return" || rawName === "enter") return "enter";
  if (rawName === "esc" || rawName === "escape") return "escape";
  if (rawName === "tab") return "tab";
  return rawName;
}

export function keyNameFromSequence(sequence?: string): string {
  if (!sequence) return "";

  const kittyName = keyNameFromKittySequence(sequence);
  if (kittyName) return kittyName;

  if (sequence === "\x1b[D" || /^\x1b\[[0-9;]*D$/.test(sequence)) return "left";
  if (sequence === "\x1b[C" || /^\x1b\[[0-9;]*C$/.test(sequence)) return "right";
  if (sequence === "\x1b[A" || /^\x1b\[[0-9;]*A$/.test(sequence)) return "up";
  if (sequence === "\x1b[B" || /^\x1b\[[0-9;]*B$/.test(sequence)) return "down";
  if (sequence === "\x1bOD") return "left";
  if (sequence === "\x1bOC") return "right";
  if (sequence === "\x1bOA") return "up";
  if (sequence === "\x1bOB") return "down";
  if (sequence === "\t") return "tab";
  if (sequence === "\r" || sequence === "\n") return "enter";
  if (isEscapeSequence(sequence)) return "escape";
  return "";
}

function keyNameFromKittySequence(sequence: string): string {
  const kittyMatch = /^\x1b\[(\d+)(?:;[1-9]\d*(?::[1-3])?)?u$/.exec(sequence);
  const kittyCode = kittyMatch?.[1] ? Number(kittyMatch[1]) : NaN;
  if (!Number.isNaN(kittyCode)) return keyNameFromKittyCode(kittyCode);

  const modifyOtherKeysMatch = /^\x1b\[27;[1-9]\d*(?::[1-3])?;(\d+)~$/.exec(sequence);
  const modifyOtherKeysCode = modifyOtherKeysMatch?.[1] ? Number(modifyOtherKeysMatch[1]) : NaN;
  if (!Number.isNaN(modifyOtherKeysCode)) return keyNameFromKittyCode(modifyOtherKeysCode);

  return "";
}

function keyNameFromKittyCode(code: number): string {
  switch (code) {
    case 27:
    case 57344:
      return "escape";
    case 9:
    case 57346:
      return "tab";
    case 13:
    case 57345:
      return "enter";
    case 57350:
      return "left";
    case 57351:
      return "right";
    case 57352:
      return "up";
    case 57353:
      return "down";
    default:
      return "";
  }
}

export function keyNameFromEvent(event: any): string {
  const rawName = normalizeKeyName(event?.name || event?.key || event?.input);
  return rawName || keyNameFromSequence(event?.raw || event?.sequence);
}

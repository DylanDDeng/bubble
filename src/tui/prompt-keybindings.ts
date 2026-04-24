import type { KeyBinding } from "@opentui/core";

export const PROMPT_TEXTAREA_KEYBINDINGS = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
  { name: "linefeed", action: "newline" },
] satisfies KeyBinding[];

export function isModifiedEnterSequence(input: { raw?: string; sequence?: string }) {
  const value = input.sequence || input.raw || "";
  return /^\x1b\[13;[2-9]\d*[u~]$/.test(value)
    || /^\x1b\[27;[2-9]\d*;13~$/.test(value);
}

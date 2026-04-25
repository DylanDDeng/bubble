import { describe, expect, it } from "vitest";
import {
  isModeCycleKeyEvent,
  isModeCycleSequence,
  isModifiedEnterSequence,
  PROMPT_TEXTAREA_KEYBINDINGS,
} from "../tui/prompt-keybindings.js";

function actionFor(input: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean }) {
  return PROMPT_TEXTAREA_KEYBINDINGS.find((binding) =>
    binding.name === input.name
    && Boolean(binding.ctrl) === Boolean(input.ctrl)
    && Boolean(binding.shift) === Boolean(input.shift)
    && Boolean(binding.meta) === Boolean(input.meta)
  )?.action;
}

describe("prompt textarea keybindings", () => {
  it("matches opencode-style submit and newline bindings", () => {
    expect(actionFor({ name: "return" })).toBe("submit");
    expect(actionFor({ name: "return", shift: true })).toBe("newline");
    expect(actionFor({ name: "return", ctrl: true })).toBe("newline");
    expect(actionFor({ name: "return", meta: true })).toBe("newline");
    expect(actionFor({ name: "j", ctrl: true })).toBe("newline");
    expect(actionFor({ name: "linefeed" })).toBe("newline");
  });

  it("detects modified enter escape sequences when the parser does not normalize them", () => {
    expect(isModifiedEnterSequence({ sequence: "\x1b[13;2u" })).toBe(true);
    expect(isModifiedEnterSequence({ raw: "\x1b[13;5u" })).toBe(true);
    expect(isModifiedEnterSequence({ sequence: "\x1b[13;2~" })).toBe(true);
    expect(isModifiedEnterSequence({ sequence: "\x1b[27;2;13~" })).toBe(true);
    expect(isModifiedEnterSequence({ sequence: "\r" })).toBe(false);
    expect(isModifiedEnterSequence({ sequence: "\x1b[13u" })).toBe(false);
  });

  it("detects tab mode-cycle keys before textarea handling", () => {
    expect(isModeCycleSequence("\t")).toBe(true);
    expect(isModeCycleSequence("\x1b[Z")).toBe(true);
    expect(isModeCycleSequence("\x1b[9;1u")).toBe(true);
    expect(isModeCycleSequence("\x1b[9;2u")).toBe(true);
    expect(isModeCycleSequence("\x1b[57346;2u")).toBe(true);
    expect(isModeCycleSequence("\x1b[27;2;9~")).toBe(true);
    expect(isModeCycleSequence("\r")).toBe(false);

    expect(isModeCycleKeyEvent({ name: "tab" })).toBe(true);
    expect(isModeCycleKeyEvent({ name: "backtab" })).toBe(true);
    expect(isModeCycleKeyEvent({ name: "shift+tab" })).toBe(true);
    expect(isModeCycleKeyEvent({ name: "", raw: "\x1b[Z" })).toBe(true);
  });
});

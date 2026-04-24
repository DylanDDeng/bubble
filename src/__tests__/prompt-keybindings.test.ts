import { describe, expect, it } from "vitest";
import { isModifiedEnterSequence, PROMPT_TEXTAREA_KEYBINDINGS } from "../tui/prompt-keybindings.js";

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
});

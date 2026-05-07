import { describe, expect, it } from "vitest";
import { keyNameFromEvent, keyNameFromSequence } from "../tui/global-key-router.js";

describe("global key router", () => {
  it("normalizes escape from raw, kitty, and modifyOtherKeys encodings", () => {
    expect(keyNameFromSequence("\x1b")).toBe("escape");
    expect(keyNameFromSequence("\x1b[27u")).toBe("escape");
    expect(keyNameFromSequence("\x1b[27;1u")).toBe("escape");
    expect(keyNameFromSequence("\x1b[27;1:1u")).toBe("escape");
    expect(keyNameFromSequence("\x1b[57344u")).toBe("escape");
    expect(keyNameFromSequence("\x1b[57344;1:3u")).toBe("escape");
    expect(keyNameFromSequence("\x1b[27;1;27~")).toBe("escape");
    expect(keyNameFromSequence("\x1b[27;1:1;27~")).toBe("escape");
  });

  it("normalizes parsed events and common terminal aliases", () => {
    expect(keyNameFromEvent({ name: "escape" })).toBe("escape");
    expect(keyNameFromEvent({ name: "esc" })).toBe("escape");
    expect(keyNameFromEvent({ name: "return" })).toBe("enter");
    expect(keyNameFromEvent({ name: "arrowdown" })).toBe("down");
    expect(keyNameFromEvent({ name: "", raw: "\x1b[27u" })).toBe("escape");
  });

  it("keeps non-escape keys distinct", () => {
    expect(keyNameFromSequence("\t")).toBe("tab");
    expect(keyNameFromSequence("\r")).toBe("enter");
    expect(keyNameFromSequence("\x1b[B")).toBe("down");
    expect(keyNameFromSequence("\x1b[13u")).toBe("enter");
  });
});

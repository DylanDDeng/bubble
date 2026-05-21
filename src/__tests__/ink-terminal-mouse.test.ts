import { describe, expect, it } from "vitest";
import {
  hasTerminalMouseSequence,
  parseTerminalMouseWheel,
  stripTerminalMouseSequences,
} from "../tui-ink/terminal-mouse.js";

describe("Ink terminal mouse parsing", () => {
  it("parses SGR wheel events", () => {
    expect(parseTerminalMouseWheel("\x1b[<64;12;5M\x1b[<65;12;6M")).toEqual(["up", "down"]);
  });

  it("strips mouse sequences before they reach the prompt buffer", () => {
    const input = "a\x1b[<64;12;5Mb";

    expect(hasTerminalMouseSequence(input)).toBe(true);
    expect(stripTerminalMouseSequences(input)).toBe("ab");
  });

  it("strips SGR mouse fragments after Ink has consumed escape bytes", () => {
    const input = "[<2;157;20M<2;157;20m";

    expect(hasTerminalMouseSequence(input)).toBe(true);
    expect(stripTerminalMouseSequences(input)).toBe("");
  });
});

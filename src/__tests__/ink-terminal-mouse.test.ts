import { describe, expect, it } from "vitest";
import {
  ALTERNATE_SCROLL_DISABLE,
  ALTERNATE_SCROLL_ENABLE,
  hasTerminalMouseSequence,
  isTerminalMouseReportingEnabled,
  MOUSE_REPORTING_DISABLE,
  MOUSE_REPORTING_ENABLE,
  parseTerminalMouseWheel,
  sanitizeTerminalMouseInput,
  stripTerminalMouseSequences,
  transcriptScrollLinesFromMouseInput,
} from "../tui/model/terminal-mouse.js";

describe("Ink terminal mouse parsing", () => {
  it("keeps alternate-scroll disabled when mouse reporting handles wheel input", () => {
    expect(ALTERNATE_SCROLL_ENABLE).toBe("\x1b[?1007h");
    expect(ALTERNATE_SCROLL_DISABLE).toBe("\x1b[?1007l");
    expect(MOUSE_REPORTING_ENABLE).toContain("\x1b[?1000h");
    expect(MOUSE_REPORTING_ENABLE).toContain("\x1b[?1006h");
  });

  it("keeps terminal mouse reporting disabled unless explicitly enabled", () => {
    expect(isTerminalMouseReportingEnabled({})).toBe(false);
    expect(isTerminalMouseReportingEnabled({ BUBBLE_ENABLE_MOUSE: "0" })).toBe(false);
    expect(isTerminalMouseReportingEnabled({ BUBBLE_ENABLE_MOUSE: "1" })).toBe(true);
    expect(isTerminalMouseReportingEnabled({ BUBBLE_TUI_MOUSE: "true" })).toBe(true);
  });

  it("parses SGR wheel events", () => {
    expect(parseTerminalMouseWheel("\x1b[<64;12;5M\x1b[<65;12;6M")).toEqual(["up", "down"]);
  });

  it("parses modified SGR wheel events", () => {
    expect(parseTerminalMouseWheel("\x1b[<68;12;5M\x1b[<69;12;6M")).toEqual(["up", "down"]);
  });

  it("parses legacy X10 wheel events", () => {
    const wheelUp = `\x1b[M${String.fromCharCode(64 + 32)}!!`;
    const wheelDown = `\x1b[M${String.fromCharCode(65 + 32)}!!`;

    expect(parseTerminalMouseWheel(`${wheelUp}${wheelDown}`)).toEqual(["up", "down"]);
  });

  it("disables common terminal mouse reporting modes defensively", () => {
    expect(MOUSE_REPORTING_DISABLE).toContain("\x1b[?1000l");
    expect(MOUSE_REPORTING_DISABLE).toContain("\x1b[?1005l");
    expect(MOUSE_REPORTING_DISABLE).toContain("\x1b[?1006l");
    expect(MOUSE_REPORTING_DISABLE).toContain("\x1b[?1015l");
  });

  it("strips mouse sequences before they reach the prompt buffer", () => {
    const input = "a\x1b[<64;12;5Mb";

    expect(hasTerminalMouseSequence(input)).toBe(true);
    expect(stripTerminalMouseSequences(input)).toBe("ab");
  });

  it("strips legacy X10 mouse sequences before they reach the prompt buffer", () => {
    const input = `a\x1b[M${String.fromCharCode(64 + 32)}!!b`;

    expect(hasTerminalMouseSequence(input)).toBe(true);
    expect(stripTerminalMouseSequences(input)).toBe("ab");
  });

  it("strips SGR mouse fragments after Ink has consumed escape bytes", () => {
    const input = "[<2;157;20M<2;157;20m";

    expect(hasTerminalMouseSequence(input)).toBe(true);
    expect(stripTerminalMouseSequences(input)).toBe("");
  });

  it("does not strip raw SGR-looking text embedded in ordinary input", () => {
    const input = "keep [<64;12;5M as text";

    expect(hasTerminalMouseSequence(input)).toBe(false);
    expect(stripTerminalMouseSequences(input)).toBe(input);
  });

  it("does not treat raw X10-looking text as mouse input without escape", () => {
    const input = "[Mabc";

    expect(hasTerminalMouseSequence(input)).toBe(false);
    expect(stripTerminalMouseSequences(input)).toBe(input);
  });

  it("reports stripped input, wheel directions, and mouse presence together", () => {
    const result = sanitizeTerminalMouseInput("a\x1b[<64;12;5Mb");

    expect(result).toEqual({
      strippedInput: "ab",
      wheelDirections: ["up"],
      hasMouse: true,
    });
  });

  it("only turns wheel events into transcript scroll lines when no overlay is active", () => {
    const mouseInput = sanitizeTerminalMouseInput("\x1b[<64;12;5M\x1b[<65;12;6M");

    expect(transcriptScrollLinesFromMouseInput(mouseInput, { overlayActive: false })).toEqual([-1, 1]);
    expect(transcriptScrollLinesFromMouseInput(mouseInput, { overlayActive: true })).toEqual([]);
  });
});

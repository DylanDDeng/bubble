import { describe, expect, it } from "vitest";
import { shouldUseOpenTuiRenderer } from "../tui/renderer-choice.js";

describe("renderer choice", () => {
  it("defaults to the Ink renderer", () => {
    expect(shouldUseOpenTuiRenderer({})).toBe(false);
    expect(shouldUseOpenTuiRenderer({ BUBBLE_TUI: "ink" })).toBe(false);
  });

  it("keeps OpenTUI as an explicit fallback", () => {
    expect(shouldUseOpenTuiRenderer({ BUBBLE_TUI: "opentui" })).toBe(true);
  });
});

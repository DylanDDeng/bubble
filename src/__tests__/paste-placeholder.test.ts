import { describe, expect, it } from "vitest";
import {
  createPastedContentMarker,
  decodePastedBytes,
  expandPastedContentMarkers,
  LONG_PASTE_CHAR_THRESHOLD,
  LONG_PASTE_LINE_THRESHOLD,
  shouldCollapsePastedContent,
} from "../tui/paste-placeholder.js";

describe("paste placeholder", () => {
  it("collapses pastes above the char or line thresholds only", () => {
    expect(shouldCollapsePastedContent("short text")).toBe(false);
    expect(shouldCollapsePastedContent("x".repeat(LONG_PASTE_CHAR_THRESHOLD))).toBe(true);
    expect(shouldCollapsePastedContent(Array(LONG_PASTE_LINE_THRESHOLD).fill("line").join("\n"))).toBe(true);
    expect(shouldCollapsePastedContent(Array(LONG_PASTE_LINE_THRESHOLD - 1).fill("line").join("\n"))).toBe(false);
  });

  it("labels markers with line counts for multiline content", () => {
    const multiline = Array(25).fill("line").join("\n");
    expect(createPastedContentMarker(multiline, 6)).toBe("[Pasted text #6 +25 lines]");

    const singleLine = "y".repeat(1200);
    expect(createPastedContentMarker(singleLine, 1)).toBe("[Pasted text #1 +1200 chars]");
  });

  it("decodes paste event bytes from string or Uint8Array", () => {
    expect(decodePastedBytes("hello")).toBe("hello");
    expect(decodePastedBytes(new TextEncoder().encode("你好 world"))).toBe("你好 world");
    expect(decodePastedBytes(Buffer.from("buffer text"))).toBe("buffer text");
    expect(decodePastedBytes(undefined)).toBe("");
    expect(decodePastedBytes(42)).toBe("");
  });

  it("round-trips: collapse on paste, expand on submit", () => {
    const pasted = Array(30).fill("const x = 1;").join("\n");
    const marker = createPastedContentMarker(pasted, 1);
    const draft = `please review this:\n${marker}\nthanks`;

    const expanded = expandPastedContentMarkers(draft, [{ marker, content: pasted }]);
    expect(expanded).toBe(`please review this:\n${pasted}\nthanks`);
  });

  it("expands multiple markers and leaves unknown markers literal", () => {
    const refs = [
      { marker: "[Pasted text #1 +20 lines]", content: "AAA" },
      { marker: "[Pasted text #2 +30 lines]", content: "BBB" },
    ];
    const draft = "[Pasted text #1 +20 lines] mid [Pasted text #2 +30 lines] and [Pasted text #9 +5 lines]";

    expect(expandPastedContentMarkers(draft, refs)).toBe("AAA mid BBB and [Pasted text #9 +5 lines]");
  });
});

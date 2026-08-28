import { afterEach, describe, expect, it } from "vitest";
import { visualWidth, graphemeWidth, ambiguousIsWide, setAmbiguousWide } from "../tui/model/width.js";

afterEach(() => setAmbiguousWide(false));

describe("width — ambiguous-width verdict", () => {
  it("counts ambiguous chars as 1 in narrow mode, 2 in wide mode", () => {
    const ambiguous = ["“", "”", "—", "●", "…"]; // EastAsianWidth=A
    setAmbiguousWide(false);
    for (const c of ambiguous) expect(graphemeWidth(c)).toBe(1);
    setAmbiguousWide(true);
    for (const c of ambiguous) expect(graphemeWidth(c)).toBe(2);
  });

  it("never changes unambiguous chars across modes", () => {
    for (const wide of [false, true]) {
      setAmbiguousWide(wide);
      expect(graphemeWidth("A")).toBe(1); // narrow
      expect(graphemeWidth("中")).toBe(2); // wide
      expect(graphemeWidth("、")).toBe(2); // wide CJK punctuation
    }
  });

  it("visualWidth sums per-grapheme and tracks the verdict", () => {
    const seg = "“点外面不关”"; // 2 curly quotes + 5 wide CJK
    setAmbiguousWide(false);
    expect(visualWidth(seg)).toBe(12); // 5*2 + 2*1
    setAmbiguousWide(true);
    expect(visualWidth(seg)).toBe(14); // 5*2 + 2*2
  });

  it("ambiguousIsWide reflects the current verdict", () => {
    setAmbiguousWide(true);
    expect(ambiguousIsWide()).toBe(true);
    setAmbiguousWide(false);
    expect(ambiguousIsWide()).toBe(false);
  });

  it("returns 0 for empty input", () => {
    expect(visualWidth("")).toBe(0);
    expect(graphemeWidth("")).toBe(0);
  });
});

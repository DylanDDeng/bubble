import { describe, expect, it } from "vitest";
import { findLastBlockStart } from "../tui-ink/markdown.js";

describe("findLastBlockStart", () => {
  it("returns 0 for an empty string", () => {
    expect(findLastBlockStart("")).toBe(0);
  });

  it("returns text.length for whitespace-only input (no blocks)", () => {
    const text = "  \n\n  ";
    expect(findLastBlockStart(text)).toBe(text.length);
  });

  it("returns 0 when the entire text is a single in-flight paragraph", () => {
    expect(findLastBlockStart("paragraph being typed")).toBe(0);
  });

  it("commits a closed paragraph once the next block begins", () => {
    // "para1\n\npara2"  →  para2 starts at offset 7
    const text = "para1\n\npara2";
    expect(findLastBlockStart(text)).toBe(7);
    expect(text.substring(0, 7)).toBe("para1\n\n");
    expect(text.substring(7)).toBe("para2");
  });

  it("keeps an unclosed code block as the in-flight block", () => {
    // No closing fence yet — the whole code block stays unstable.
    expect(findLastBlockStart("```py\nx = 1\ny = 2")).toBe(0);
  });

  it("commits a closed code block once any subsequent block starts", () => {
    const text = "```py\nx = 1\n```\nNext paragraph";
    const cut = findLastBlockStart(text);
    expect(text.substring(0, cut)).toBe("```py\nx = 1\n```\n");
    expect(text.substring(cut)).toBe("Next paragraph");
  });

  it("keeps a streaming table as the in-flight block", () => {
    const text = "| a | b |\n| - | - |\n| 1 | 2 |";
    expect(findLastBlockStart(text)).toBe(0);
  });

  it("commits a finished table when a paragraph follows", () => {
    const text = "| a | b |\n| - | - |\n| 1 | 2 |\n\nafterwards";
    const cut = findLastBlockStart(text);
    expect(text.substring(cut)).toBe("afterwards");
    // Everything before the trailing paragraph is committed (includes the
    // table rows plus the blank-line separator).
    expect(text.substring(0, cut).endsWith("\n\n")).toBe(true);
  });

  it("treats multi-line paragraphs as a single block", () => {
    // A single newline does NOT split a paragraph — only "\n\n" does.
    expect(findLastBlockStart("line one\nline two\nline three")).toBe(0);
  });

  it("returns the start of the latest block when multiple closed blocks precede it", () => {
    const text = "# Heading\n\nparagraph one\n\nparagraph two";
    const cut = findLastBlockStart(text);
    expect(text.substring(cut)).toBe("paragraph two");
  });

  it("advances monotonically as streaming tokens arrive", () => {
    // Simulate the lex behaviour StreamingMarkdown depends on: the offset of
    // the in-flight block never moves backward as content grows.
    let prevCut = 0;
    const stages = [
      "# Heading",
      "# Heading\n",
      "# Heading\n\n",
      "# Heading\n\nbody",
      "# Heading\n\nbody being typed",
      "# Heading\n\nbody being typed\n\n",
      "# Heading\n\nbody being typed\n\n```",
      "# Heading\n\nbody being typed\n\n```py\n",
      "# Heading\n\nbody being typed\n\n```py\nprint(1)",
    ];
    for (const stage of stages) {
      const cut = findLastBlockStart(stage);
      // For each stage, the stable prefix should be a prefix of `stage`.
      expect(stage.startsWith(stage.substring(0, cut))).toBe(true);
      // And it never shrinks relative to the previous stage's commitment,
      // as long as the previous stable prefix is still a prefix of the new
      // content (it always is in this simulation).
      expect(cut).toBeGreaterThanOrEqual(prevCut);
      prevCut = cut;
    }
  });
});

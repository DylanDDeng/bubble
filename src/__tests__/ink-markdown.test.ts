import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks, parseMarkdownInlineSegments } from "../tui-ink/markdown.js";

describe("Ink markdown renderer parsing", () => {
  it("parses bold and inline code without leaking raw markers", () => {
    const segments = parseMarkdownInlineSegments("Use **bold text** and `inline_code()`.");

    expect(segments.map((segment) => segment.text).join("")).toBe("Use bold text and inline_code().");
    expect(segments).toContainEqual({ text: "bold text", bold: true });
    expect(segments).toContainEqual({ text: "inline_code()", code: true });
  });

  it("keeps markdown markers literal inside inline code", () => {
    const segments = parseMarkdownInlineSegments("Run `echo **raw** | cat` now");

    expect(segments.map((segment) => segment.text).join("")).toBe("Run echo **raw** | cat now");
    expect(segments).toContainEqual({ text: "echo **raw** | cat", code: true });
  });

  it("does not treat underscores inside words as emphasis", () => {
    const segments = parseMarkdownInlineSegments("snake_case_name and _emphasis_");

    expect(segments.map((segment) => segment.text).join("")).toBe("snake_case_name and emphasis");
    expect(segments.some((segment) => segment.text === "snake_case_name" && segment.italic)).toBe(false);
    expect(segments).toContainEqual({ text: "emphasis", italic: true });
  });

  it("requires a markdown separator row before parsing a table", () => {
    const blocks = parseMarkdownBlocks("| maybe | not |\n| still | text |");

    expect(blocks).toEqual([
      { type: "paragraph", lines: ["| maybe | not |", "| still | text |"] },
    ]);
  });

  it("parses table rows without splitting escaped pipes or code span pipes", () => {
    const blocks = parseMarkdownBlocks([
      "| Name | Value |",
      "| --- | --- |",
      "| **Bold** | `a | b` |",
      "| escaped \\| pipe | plain |",
    ].join("\n"));

    expect(blocks).toEqual([
      {
        type: "table",
        headers: ["Name", "Value"],
        rows: [
          ["**Bold**", "`a | b`"],
          ["escaped | pipe", "plain"],
        ],
      },
    ]);
  });
});

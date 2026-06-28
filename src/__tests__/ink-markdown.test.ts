import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks, parseMarkdownInlineSegments, splitListItem } from "../tui-ink/markdown.js";

describe("splitListItem — hanging-indent detection", () => {
  it("detects bullet and ordered markers with their hanging-indent width", () => {
    expect(splitListItem("- Claude 分支：永远渲染")).toEqual({
      prefix: "- ",
      content: "Claude 分支：永远渲染",
      indent: 2,
    });
    expect(splitListItem("1. **Hook** (useComposerAgentSelection.ts)")).toEqual({
      prefix: "1. ",
      content: "**Hook** (useComposerAgentSelection.ts)",
      indent: 3,
    });
    expect(splitListItem("2) item")?.prefix).toBe("2) ");
  });

  it("includes leading whitespace of nested items in the indent", () => {
    const nested = splitListItem("    - 嵌套项");
    expect(nested?.prefix).toBe("    - ");
    expect(nested?.indent).toBe(6);
  });

  it("ignores non-list lines (no false positives)", () => {
    expect(splitListItem("普通段落，不是列表。")).toBeNull();
    expect(splitListItem("1.5x 不是有序列表")).toBeNull(); // no space after marker
    expect(splitListItem("-没有空格")).toBeNull();
    expect(splitListItem("- ")).toBeNull(); // empty item content
  });
});

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

  it("preserves cells containing emoji and CJK without truncating them", () => {
    const blocks = parseMarkdownBlocks([
      "| 类别 | 文件 |",
      "| --- | --- |",
      "| 🎮 游戏 | tetris_game.py |",
      "| 🎉 节日 | 儿童节、圣诞节、端午节 |",
      "| 🏙️ 场景 | 上海、四合院 |",
      "| 📦 工具 | About Bubble、Claude Code |",
    ].join("\n"));

    expect(blocks).toEqual([
      {
        type: "table",
        headers: ["类别", "文件"],
        rows: [
          ["🎮 游戏", "tetris_game.py"],
          ["🎉 节日", "儿童节、圣诞节、端午节"],
          ["🏙️ 场景", "上海、四合院"],
          ["📦 工具", "About Bubble、Claude Code"],
        ],
      },
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

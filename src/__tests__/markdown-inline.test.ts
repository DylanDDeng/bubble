import { describe, expect, it } from "vitest";
import { markdownInlineSegments } from "../tui/markdown-inline.js";

describe("markdown inline formatting", () => {
  it("renders inline markdown text without raw markers", () => {
    const segments = markdownInlineSegments([
      {
        type: "text",
        text: "**创建新文档** — 用 `docx` 生成文件",
        tokens: [
          { type: "strong", text: "创建新文档", tokens: [{ type: "text", text: "创建新文档" }] },
          { type: "text", text: " — 用 " },
          { type: "codespan", text: "docx" },
          { type: "text", text: " 生成文件" },
        ],
      },
    ]);

    const rendered = segments.map((segment) => segment.text).join("");
    expect(rendered).toBe("创建新文档 — 用 docx 生成文件");
    expect(rendered).not.toContain("**");
    expect(rendered).not.toContain("`");
    expect(segments[0]).toMatchObject({ text: "创建新文档", bold: true });
    expect(segments[2]).toMatchObject({ text: "docx", color: "success" });
  });
});

import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import { projectReasoningRows, wrapPlain } from "../tui/components/transcript.js";
import { ResponsiveTranscriptComponent } from "../tui/components/responsive-transcript.js";

vi.mock("string-width", async (importOriginal) => {
  const actual = await importOriginal<typeof import("string-width")>();
  return { ...actual, default: vi.fn(actual.default) };
});

describe("long transcript layout work", () => {
  it("wraps one million ASCII characters without Unicode segmentation", () => {
    const word = "reasoning";
    const text = `${word} `.repeat(100_000).trim();
    vi.mocked(stringWidth).mockClear();
    const rows = wrapPlain(text, 79);
    expect(rows.join(" ")).toBe(text);
    expect(rows.every((row) => row.length <= 79)).toBe(true);
    expect(stringWidth).not.toHaveBeenCalled();
  });

  it("preserves CJK, combining marks and emoji widths", () => {
    for (const text of ["你好世界 test 中文", "e\u0301 e\u0301 test", "👩‍💻 hello 👨‍👩‍👧‍👦", "longwordwithoutspaces"]) {
      const rows = wrapPlain(text, 40);
      expect(rows.join(" ")).toBe(text);
      expect(rows.every((row) => stringWidth(row) <= 40)).toBe(true);
    }
    expect(wrapPlain("你好世界你好", 4)).toEqual(["你好", "世界", "你好"]);
  });

  it("reuses the million-character settled projection for input and scroll frames", () => {
    const messages = [{ key: "done", role: "assistant" as const, content: "Done", reasoning: "checking state ".repeat(66_667) }];
    const component = new ResponsiveTranscriptComponent(() => ({ messages, options: { showReasoning: false } }));
    const rows = component.render(100);
    vi.mocked(stringWidth).mockClear();
    for (let frame = 0; frame < 30; frame++) expect(component.render(100)).toBe(rows);
    expect(stringWidth).not.toHaveBeenCalled();
    expect(messages[0]!.reasoning.length).toBeGreaterThan(1_000_000);
  });

  it("bounds Unicode measurement on cold layout, resize and new messages", () => {
    const reasoning = "分析当前状态并检查输入是否正常。".repeat(62_500);
    let messages = [{ key: "done", role: "assistant" as const, content: "Done", reasoning }];
    const component = new ResponsiveTranscriptComponent(() => ({ messages, options: { showReasoning: false } }));
    for (const width of [100, 99, 99]) {
      vi.mocked(stringWidth).mockClear();
      const rows = component.render(width);
      // Previously each discarded CJK row invoked Unicode segmentation.
      expect(vi.mocked(stringWidth).mock.calls.length).toBeLessThan(100);
      expect(rows.length).toBeLessThan(20);
      messages = [...messages, { key: `next-${messages.length}`, role: "assistant", content: "Next", reasoning: "" }];
    }
    expect(messages[0]!.reasoning).toBe(reasoning);
  });

  it("preserves exact expanded row boundaries in head and tail previews", () => {
    const samples = [
      "你好世界。检查状态，继续执行！".repeat(200),
      "one two three four five six ".repeat(100),
      "\n  \nfirst line\n\n" + "👩‍💻 e\u0301 中文 ".repeat(100) + "\n last line \n",
    ];
    for (const content of samples) {
      for (const columns of [1, 8, 19, 80]) {
        const options = { columns, showReasoning: true };
        const expanded = projectReasoningRows(content, options).slice(1);
        for (const limit of [0, 1, 5, expanded.length, expanded.length + 1]) {
          for (const fromEnd of [true, false]) {
            const preview = projectReasoningRows(content, options, { maxBodyRows: limit, fromEnd });
            const expected = limit === 0 ? [] : fromEnd ? expanded.slice(-limit) : expanded.slice(0, limit);
            expect(preview.slice(1, 1 + expected.length)).toEqual(expected);
            expect(preview.length).toBe(1 + expected.length + Number(expanded.length > limit));
          }
        }
      }
    }
    expect(projectReasoningRows("\n \t\n", { columns: 80 })).toEqual([]);
  });
});

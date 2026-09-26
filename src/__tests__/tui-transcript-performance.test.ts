import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import { wrapPlain } from "../tui/components/transcript.js";
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
});

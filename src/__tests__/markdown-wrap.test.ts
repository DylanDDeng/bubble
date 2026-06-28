import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { parseMarkdownInlineSegments, wrapInlineSegments } from "../tui-ink/markdown.js";

function wrapText(text: string, maxWidth: number): string[] {
  return wrapInlineSegments(parseMarkdownInlineSegments(text), maxWidth).map((line) =>
    line.map((segment) => segment.text).join(""),
  );
}

describe("wrapInlineSegments — CJK-aware wrapping", () => {
  // The exact shape that corrupted the transcript: identifiers joined by the
  // ideographic comma "、" with no ASCII space.
  const cjkRun =
    "类型层: shared/types.ts (ProviderKind、ProviderSessionStartInput、ProviderSendTurnInput)、electron/types.ts";

  it("never splits an ASCII identifier mid-token across a CJK-comma run", () => {
    for (const width of [40, 60, 80, 100]) {
      const lines = wrapText(cjkRun, width);
      for (let i = 0; i < lines.length - 1; i++) {
        const endsAlnum = /[A-Za-z0-9]$/.test(lines[i]);
        const nextAlnum = /^[A-Za-z0-9]/.test(lines[i + 1]);
        expect(endsAlnum && nextAlnum, `mid-word break at width ${width}: ${lines[i]} | ${lines[i + 1]}`).toBe(false);
      }
    }
  });

  it("breaks after CJK punctuation (、,。) when the next chunk overflows", () => {
    const text = "presetToCreateRequest)、每手扩展一加一个预设其他内容push";
    const lines = wrapText(text, 50);
    const rejoined = lines.join("");
    expect(rejoined.replace(/ /g, "")).toBe(text.replace(/ /g, ""));
    for (let i = 0; i < lines.length - 1; i++) {
      const endsAlnum = /[A-Za-z0-9]$/.test(lines[i]);
      const nextAlnum = /^[A-Za-z0-9]/.test(lines[i + 1]);
      expect(endsAlnum && nextAlnum, `mid-ASCII-word break: ${lines[i]} | ${lines[i + 1]}`).toBe(false);
    }
  });

  it("keeps every wrapped line within maxWidth", () => {
    for (const width of [30, 50, 80, 120]) {
      for (const line of wrapText(cjkRun, width)) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("preserves all non-break characters", () => {
    const rejoined = wrapText(cjkRun, 50).join("").replace(/ /g, "");
    expect(rejoined).toBe(cjkRun.replace(/ /g, ""));
  });

  it("breaks plain English only at spaces (whole words)", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 12);
    expect(lines.every((l) => stringWidth(l) <= 12)).toBe(true);
    expect(lines.join(" ").replace(/\s+/g, " ").trim()).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("hard-splits a single token wider than the whole line", () => {
    const lines = wrapText("aaaaaaaaaaaaaaaaaaaa", 5); // 20 chars, width 5
    expect(lines.length).toBe(4);
    expect(lines.every((l) => stringWidth(l) <= 5)).toBe(true);
    expect(lines.join("")).toBe("aaaaaaaaaaaaaaaaaaaa");
  });

  it("preserves inline-code styling across a wrap boundary", () => {
    // `code` spans must remain styled even when the line breaks inside the run.
    const segments = wrapInlineSegments(
      parseMarkdownInlineSegments("`一二三四五六七八九十`"),
      6,
    );
    const flat = segments.flat();
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((s) => s.code === true)).toBe(true);
  });

  it("returns a single line when maxWidth is non-positive", () => {
    const segments = parseMarkdownInlineSegments(cjkRun);
    expect(wrapInlineSegments(segments, 0)).toHaveLength(1);
  });
});

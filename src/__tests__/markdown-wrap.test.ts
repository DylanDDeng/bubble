import { afterEach, describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { parseMarkdownInlineSegments, wrapInlineSegments } from "../tui-ink/markdown.js";
import { setAmbiguousWide } from "../tui-ink/width.js";

afterEach(() => setAmbiguousWide(false));

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

  it("counts East Asian ambiguous chars (curly quotes, em dash) as width 2 when terminal renders wide", () => {
    // On an ambiguous-wide terminal “ ” — render as 2 cells, not 1. If we
    // wrapped against the width-1 measurement, lines we believe fit exactly
    // would overflow and the terminal's own hard wrap would drop the tail onto
    // a stray row. The startup probe sets this verdict; force it here.
    setAmbiguousWide(true);
    const text =
      "迁完很容易出“点外面不关”“Tab顺序错”“背景滚动”这类回归，而且不一定立刻发现—Aegis 没有覆盖这些交互的测试。";
    for (const width of [40, 60, 80, 95]) {
      for (const line of wrapText(text, width)) {
        expect(
          stringWidth(line, { ambiguousIsNarrow: false }),
          `line overflows CJK terminal at width ${width}: ${line}`,
        ).toBeLessThanOrEqual(width);
      }
    }
  });

  it("never starts a wrapped line with a closing bracket or trailing punctuation (避头)", () => {
    setAmbiguousWide(true);
    const text =
      "成一个纯扁平的 model 列表（没有 reasoning）。否则渲染 rich 的 CodexAgentSubContent（Reasoning + Model + Speed）。";
    const noStart = /^[、，。．！？；：）)〕】｝」』》〉…]/;
    for (const width of [40, 60, 80, 100]) {
      for (const line of wrapText(text, width)) {
        expect(noStart.test(line), `line begins with closing punctuation at width ${width}: ${line}`).toBe(false);
      }
    }
  });

  it("never ends a wrapped line with an opening bracket (避尾)", () => {
    setAmbiguousWide(true);
    const text = "渲染一个纯扁平的（没有任何 reasoning 选项的）model 列表给当前激活的 agent 使用。";
    const noEnd = /[（(〔【｛「『《〈]$/;
    for (const width of [30, 45, 60, 80]) {
      for (const line of wrapText(text, width)) {
        expect(noEnd.test(line), `line ends with opening bracket at width ${width}: ${line}`).toBe(false);
      }
    }
  });

  it("returns a single line when maxWidth is non-positive", () => {
    const segments = parseMarkdownInlineSegments(cjkRun);
    expect(wrapInlineSegments(segments, 0)).toHaveLength(1);
  });
});

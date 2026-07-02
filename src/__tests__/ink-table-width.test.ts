import React from "react";
import { renderToString } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import { setAmbiguousWide, visualWidth } from "../tui-ink/width.js";
import type { DisplayMessage } from "../tui-ink/display-history.js";

// The /zaobo-stat regression: a wide CJK stats table. The last column is far
// wider than the terminal, so the column budget must scale it down, and every
// physical row must fit the terminal or it hard-wraps into scattered border
// fragments (the bug screenshot).
const STATS_TABLE = [
  "| 排名 | 播放 | 完播 | 完播率 | 发布时间 | 时长 | 标题 | 标签 | 收听用户 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 1 | 49 | 38 | 77.6% | 2026-07-01 | 0:29 | 世界杯前瞻 | 体育 | 老蒋(5次)、读客(3次)、temp_a7334ca6bd70(3次)、temp_2b16056d7141(2次)、悠然6687(2次)、temp_34f59231fa73(2次)、user_9959afb3e5b0(2次)、乔先生(2次)、temp_1(1次) |",
  "| 2 | 33 | 25 | 75.8% | 2026-07-01 | 0:40 | 英伟达新品 | 科技 | 黯然销魂(1次)、nic(1次)、悠然6687(1次)、temp_990dd7e10605(1次)、小周(1次)、读客(1次)、无风却起念(1次)、春天的风(1次)、user_3bcdd0663123(1次)、瓜2(1次) |",
].join("\n");

function renderTable(terminalColumns: number): string[] {
  const message: DisplayMessage = {
    key: "asst-1",
    role: "assistant",
    content: `播放排行榜 TOP 10\n\n${STATS_TABLE}`,
  };
  return renderToString(
    React.createElement(MessageList, {
      messages: [message],
      streamingContent: "",
      streamingReasoning: "",
      streamingTools: [],
      streamingParts: [],
      terminalColumns,
      verboseTrace: false,
    }),
    { columns: terminalColumns },
  ).split("\n");
}

afterEach(() => {
  setAmbiguousWide(false);
});

describe("markdown table width on narrow-ambiguous terminals", () => {
  it("keeps every physical row within the terminal width", () => {
    setAmbiguousWide(false);
    for (const columns of [80, 120, 155, 200]) {
      const lines = renderTable(columns);
      for (const line of lines) {
        expect(visualWidth(line), `column budget ${columns}: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(columns);
      }
    }
  });

  it("shaves the min-width clamp overshoot instead of overflowing", () => {
    setAmbiguousWide(false);
    // 9 columns at a width where most collapse to the 4-cell floor: the floor
    // used to push the row past the budget and the terminal hard-wrapped it.
    const lines = renderTable(60);
    const borders = lines.filter((line) => line.includes("┌") || line.includes("└"));
    expect(borders.length).toBe(2);
    for (const line of lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(60);
    }
  });
});

describe("markdown table on ambiguous-wide terminals", () => {
  it("draws ASCII borders whose physical width every layer agrees on", () => {
    setAmbiguousWide(true);
    const lines = renderTable(155);
    const joined = lines.join("\n");
    // Box-drawing ─│┌┬┼ are East Asian Ambiguous: this terminal paints them 2
    // cells wide while the column math and Ink both budget 1, so borders would
    // render at twice the designed width and wrap into fragments.
    expect(joined).not.toMatch(/[─│┌┬┐├┼┤└┴┘]/);
    expect(joined).toContain("+-");
    expect(joined).toContain("| ");
    // The physical width (ambiguous-wide verdict) must fit the terminal.
    for (const line of lines) {
      expect(visualWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(155);
    }
  });

  it("keeps CJK data rows aligned with the borders", () => {
    setAmbiguousWide(true);
    const lines = renderTable(120);
    const borderWidths = lines
      .filter((line) => /^\s*\+[-+]+\+\s*$/.test(line))
      .map((line) => visualWidth(line.trimEnd()));
    expect(borderWidths.length).toBe(3); // top, header separator, bottom
    const rowWidths = lines
      .filter((line) => line.trimStart().startsWith("|"))
      .map((line) => visualWidth(line.trimEnd()));
    expect(rowWidths.length).toBeGreaterThan(0);
    for (const width of rowWidths) {
      expect(width).toBe(borderWidths[0]);
    }
    expect(new Set(borderWidths).size).toBe(1);
  });
});

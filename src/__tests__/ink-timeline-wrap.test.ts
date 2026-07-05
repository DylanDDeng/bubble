import React from "react";
import { renderToString } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import { setAmbiguousWide, visualWidth } from "../tui-ink/width.js";
import type { DisplayMessage } from "../tui-ink/display-history.js";

// The transcript regression: a dense CJK list item packs its wrapped lines to
// exactly the wrap budget, but the budget forgot the transcript row's
// paddingX={1} (one column each side). The physical row then ends past the
// terminal edge and the terminal hard-wraps the final glyph onto a stray row
// at column 0 (the lone "这" in the bug screenshot).
const CJK_LIST_MESSAGE = [
  "关键发现!让我梳理:",
  "",
  "建议的排查步骤",
  "",
  "1. **先确认账号**:打开手机 ChatGPT App → 设置 → 看登录的邮箱,和电脑端 Codex 的 Google 账号对比",
  "2. **如果账号一致**:重新获取配对码,立即扫描",
  "3. **如果还是失败**:可能是手机端 ChatGPT App 的配对请求(`wham/remote/control/server/pair`)被 Cloudflare 拦了(和 curl 一样返回 403)。虽然用同一个节点,但 ChatGPT App 的 HTTP 客户端和 app-server 的 reqwest 行为可能不同,这种情况需要换一个住宅 IP 节点(数据中心 IP 更容易被 Cloudflare 拦)",
  "",
  "你先确认一下手机端的账号是不是和电脑端同一个?",
].join("\n");

// A plain paragraph (no list marker) that also packs flush against the budget.
const CJK_PARAGRAPH_MESSAGE =
  "配对会话绑定到电脑端的账号。如果手机端登录的不是同一个账号就会找不到会话,所以要先对比两边的登录邮箱再重新获取配对码,间隔太长会话会过期,需要立即在手机上扫描确认才能通过。".repeat(3);

function renderTranscript(content: string, terminalColumns: number): string[] {
  const message: DisplayMessage = {
    key: "asst-1",
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
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

describe("timeline markdown wrap budget", () => {
  // Sweep widths: the overflow only shows at widths where a wrapped line packs
  // into the final columns, so a range is what actually catches the bug.
  const WIDTHS = [60, 80, 90, 100, 120, 140, 160, 180, 200, 223];

  it("keeps every physical row of a CJK list item within the terminal width", () => {
    setAmbiguousWide(false);
    for (const columns of WIDTHS) {
      for (const line of renderTranscript(CJK_LIST_MESSAGE, columns)) {
        expect(visualWidth(line), `width ${columns}: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(columns);
      }
    }
  });

  it("keeps every physical row of a CJK paragraph within the terminal width", () => {
    setAmbiguousWide(false);
    for (const columns of WIDTHS) {
      for (const line of renderTranscript(CJK_PARAGRAPH_MESSAGE, columns)) {
        expect(visualWidth(line), `width ${columns}: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(columns);
      }
    }
  });

  it("fits on ambiguous-wide terminals too", () => {
    setAmbiguousWide(true);
    for (const columns of WIDTHS) {
      for (const line of renderTranscript(CJK_LIST_MESSAGE, columns)) {
        expect(visualWidth(line), `width ${columns}: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(columns);
      }
    }
  });

  it("still hang-indents wrapped list continuation lines under the item text", () => {
    setAmbiguousWide(false);
    const lines = renderTranscript(CJK_LIST_MESSAGE, 80);
    const itemRow = lines.findIndex((line) => line.includes("3. "));
    expect(itemRow).toBeGreaterThanOrEqual(0);
    const markerColumn = lines[itemRow]!.indexOf("3. ");
    const continuation = lines[itemRow + 1] ?? "";
    // Continuation text must start in the column right after the "3. " marker,
    // not collapse back to the left margin.
    expect(continuation.slice(0, markerColumn + 3).trim()).toBe("");
    expect(continuation.length).toBeGreaterThan(markerColumn + 3);
  });
});

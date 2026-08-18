/**
 * Transcript renderer tests (Phase 5): pin the row contracts the legacy
 * message-list suites guarded — user card padding, wrap width, reasoning
 * collapse, tool glyph states, error visibility.
 */
import { describe, expect, it } from "vitest";
import {
  renderMessage,
  renderToolTrace,
  renderTranscript,
  renderUserCard,
  wrapPlain,
} from "../tui/components/transcript.js";
import type { DisplayMessage } from "../tui/model/display-history.js";
import chalk from "chalk";
import stringWidth from "string-width";

chalk.level = 0; // strip ANSI for assertions

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

const msg = (partial: Partial<DisplayMessage>): DisplayMessage =>
  ({ key: "k", role: "assistant", content: "", ...partial }) as DisplayMessage;

describe("transcript renderer", () => {
  it("renders a compact user card with exact terminal-cell width", () => {
    const rows = renderUserCard("你好啊", { columns: 40 });
    expect(rows).toHaveLength(2); // top pad + body; no oversized bottom gap
    expect(rows[1]).toContain("›");
    expect(rows[1]).toContain("你好啊");
    expect(rows[0].trim()).toBe("");
    expect(rows.every((row) => stringWidth(strip(row)) === 38)).toBe(true);
  });

  it("wraps CJK by terminal cells without overflowing the painted edge", () => {
    const rows = renderUserCard("看下这个项目现在到底是在干什么以及还剩下哪些工作需要继续完成", { columns: 24 });
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((row) => stringWidth(strip(row)) === 22)).toBe(true);
    expect(rows.at(-1)).not.toBe("");
  });

  it("wraps long user text within the card and aligns continuation lines", () => {
    const rows = renderUserCard("word ".repeat(20).trim(), { columns: 30 });
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(stringWidth(strip(row))).toBe(28);
    }
  });

  it("renders assistant text wrapped to the terminal width", () => {
    const rows = renderMessage(msg({ content: "a".repeat(90) }), { columns: 40 });
    const text = rows.map((r) => strip(r));
    expect(text.some((line) => line.length <= 38 && line.startsWith("a"))).toBe(true);
    expect(rows[rows.length - 1]).toBe("");
  });

  it("collapses reasoning to one dim line unless expanded", () => {
    const collapsed = renderMessage(msg({ reasoning: "line one\nline two" }), { columns: 60 });
    expect(collapsed).toHaveLength(2);
    expect(strip(collapsed[0]!)).toContain("Thinking: line one");

    const expanded = renderMessage(msg({ reasoning: "line one" }), { columns: 60, showReasoning: true });
    expect(expanded.length).toBeGreaterThan(2);
  });

  it("tool trace glyphs: pending, success, error", () => {
    const opts = { columns: 60 };
    const pending = renderToolTrace({ id: "1", name: "bash", args: { command: "ls" } }, opts);
    const ok = renderToolTrace({ id: "1", name: "bash", args: { command: "ls" }, result: "done" }, opts);
    const err = renderToolTrace({ id: "1", name: "bash", args: { command: "ls" }, result: "boom", isError: true }, opts);

    expect(strip(pending)).toContain("… bash");
    expect(strip(ok)).toContain("✔ bash");
    expect(strip(err)).toContain("✗ bash");
    // Command preview is surfaced.
    expect(strip(ok)).toContain("ls");
  });

  it("verbose trace appends the result preview", () => {
    const row = renderToolTrace({ id: "1", name: "bash", args: {}, result: "first line\nsecond" }, { columns: 60, verboseTrace: true });
    expect(strip(row)).toContain("first line");
    expect(strip(row)).not.toContain("second");
  });

  it("error messages render on a single red line", () => {
    const rows = renderMessage(msg({ role: "error", content: "boom happened" }), { columns: 40 });
    expect(rows).toHaveLength(2);
    expect(strip(rows[0]!)).toBe("boom happened");
  });

  it("orders reasoning above tool traces above content", () => {
    const rows = renderMessage(
      msg({
        reasoning: "pondering",
        content: "final answer",
        toolCalls: [{ id: "t", name: "read", args: { path: "/x" } }],
      }),
      { columns: 60 },
    );
    const text = rows.map((r) => strip(r)).join("\n");
    const reasoningAt = text.indexOf("pondering");
    const toolAt = text.indexOf("read");
    const contentAt = text.indexOf("final answer");
    expect(reasoningAt).toBeLessThan(toolAt);
    expect(toolAt).toBeLessThan(contentAt);
  });

  it("groups provider turns into one Thinking then Working trace per user request", () => {
    const rows = renderTranscript(
      [
        msg({ key: "u", role: "user", content: "inspect" }),
        msg({ key: "a1", reasoning: "plan one", toolCalls: [{ id: "t1", name: "bash", args: { command: "ls" }, result: "ok" }] }),
        msg({ key: "a2", reasoning: "plan two", toolCalls: [{ id: "t2", name: "read", args: { path: "README.md" }, result: "ok" }] }),
        msg({ key: "a3", content: "done" }),
      ],
      { columns: 60 },
    );
    const text = rows.map(strip).join("\n");
    expect(text.match(/Thinking:/g)).toHaveLength(1);
    expect(text).toContain("plan one");
    expect(text).not.toContain("plan two");
    expect(text.match(/Working/g)).toHaveLength(1);
    expect(text.indexOf("bash")).toBeLessThan(text.indexOf("read"));
    expect(text.indexOf("read")).toBeLessThan(text.indexOf("done"));
  });

  it("preserves commentary/tool order from display parts inside Working", () => {
    const rows = renderTranscript(
      [
        msg({ role: "user", content: "go" }),
        msg({
          reasoning: "plan",
          content: "I will inspect.\nResult follows.",
          toolCalls: [{ id: "t", name: "read", args: { path: "/x" }, result: "ok" }],
          parts: [
            { type: "text", content: "I will inspect." },
            { type: "tools", toolCalls: [{ id: "t", name: "read", args: { path: "/x" }, result: "ok" }] },
            { type: "text", content: "Result follows." },
          ],
        }),
      ],
      { columns: 60 },
    );
    const text = rows.map(strip).join("\n");
    expect(text.indexOf("I will inspect.")).toBeLessThan(text.indexOf("read"));
    expect(text.indexOf("read")).toBeLessThan(text.indexOf("Result follows."));
  });

  it("wrapPlain honors explicit newlines and long words", () => {
    expect(wrapPlain("ab\ncd", 10)).toEqual(["ab", "cd"]);
    const wrapped = wrapPlain("aaaaaaaa bb", 8);
    expect(wrapped[0]).toBe("aaaaaaaa");
    expect(wrapped[1]).toBe("bb");
  });

  it("empty-content assistant with tools still renders the trace", () => {
    const rows = renderTranscript([msg({ content: "", toolCalls: [{ id: "t", name: "grep", args: {} }] })], { columns: 60 });
    expect(rows.some((r) => strip(r).includes("grep"))).toBe(true);
  });
});

describe("transcript markdown pipeline", () => {
  it("routes assistant content through the injected markdown renderer", () => {
    const calls: Array<{ text: string; width: number }> = [];
    const rows = renderMessage(msg({ content: "# Title\n\nbody" }), {
      columns: 50,
      markdownRenderer: (text, width) => {
        calls.push({ text, width });
        return ["<MD>", ...text.split("\n")];
      },
    });
    expect(calls).toEqual([{ text: "# Title\n\nbody", width: 48 }]);
    expect(rows[0]).toBe("<MD>");
    expect(rows[rows.length - 1]).toBe("");
  });

  it("falls back to plain wrapping without a renderer", () => {
    const rows = renderMessage(msg({ content: "plain words" }), { columns: 50 });
    expect(rows[0]).toBe("plain words");
  });
});

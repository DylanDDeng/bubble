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

chalk.level = 0; // strip ANSI for assertions

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

const msg = (partial: Partial<DisplayMessage>): DisplayMessage =>
  ({ key: "k", role: "assistant", content: "", ...partial }) as DisplayMessage;

describe("transcript renderer", () => {
  it("renders the user card with vertical padding, marker, and centered text", () => {
    const rows = renderUserCard("你好啊", { columns: 40 });
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain("›");
    expect(rows[1]).toContain("你好啊");
    expect(rows[0].trim()).toBe("");
    expect(rows[2].trim()).toBe("");
  });

  it("wraps long user text within the card and aligns continuation lines", () => {
    const rows = renderUserCard("word ".repeat(20).trim(), { columns: 30 });
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows.slice(1, -2)) {
      expect(row.length).toBeLessThanOrEqual(120); // ANSI-stripped later; guard raw
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
    expect(strip(collapsed[0]!)).toContain("thinking: line one");

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

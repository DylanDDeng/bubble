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
import { ResponsiveTranscriptComponent } from "../tui/components/responsive-transcript.js";
import { formatWelcomeModel, renderWelcomeBanner } from "../tui/components/welcome.js";
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
    expect(rows).toHaveLength(3); // symmetric top/body/bottom padding
    expect(rows[1]).toContain("›");
    expect(rows[1]).toContain("你好啊");
    expect(rows[0].trim()).toBe("");
    expect(rows[2].trim()).toBe("");
    expect(rows.every((row) => stringWidth(strip(row)) === 38)).toBe(true);
  });

  it("wraps CJK by terminal cells without overflowing the painted edge", () => {
    const rows = renderUserCard("看下这个项目现在到底是在干什么以及还剩下哪些工作需要继续完成", { columns: 24 });
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((row) => stringWidth(strip(row)) === 22)).toBe(true);
    expect(rows.at(-1)?.trim()).toBe("");
  });

  it("reprojects the same transcript from message state at the current width", () => {
    const messages = [msg({ key: "u", role: "user", content: "你好，resize should reflow this message" })];
    const component = new ResponsiveTranscriptComponent(() => ({ messages }));

    const narrow = component.render(24);
    const wide = component.render(60);

    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(narrow.every((row) => stringWidth(strip(row)) === 22)).toBe(true);
    expect(wide.every((row) => stringWidth(strip(row)) === 58)).toBe(true);
    expect(narrow.map(strip).join("\n")).toContain("resize");
    expect(wide.map(strip).join("\n")).toContain("resize should reflow this message");
  });

  it("wraps long user text within the card and aligns continuation lines", () => {
    const rows = renderUserCard("word ".repeat(20).trim(), { columns: 30 });
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(stringWidth(strip(row))).toBe(28);
    }
  });

  it("keeps every settled row within the real terminal width down to one column", () => {
    const messages: DisplayMessage[] = [
      msg({ key: "u", role: "user", content: "缩窗以后这条很长的用户消息仍然不能越界" }),
      msg({
        key: "a",
        reasoning: "reasoning remains visible while the final answer settles",
        content: "先检查最终回答",
        toolCalls: [{ id: "read", name: "read", args: { path: "a/very/long/path/README.md" }, result: "ok", status: "completed" }],
        parts: [
          { type: "text", content: "先检查" },
          { type: "tools", toolCalls: [{ id: "read", name: "read", args: { path: "a/very/long/path/README.md" }, result: "ok", status: "completed" }] },
          { type: "text", content: "最终回答" },
        ],
      }),
    ];

    for (const columns of [1, 4, 12, 20, 40]) {
      const rows = renderTranscript(messages, { columns });
      expect(rows.every((row) => stringWidth(strip(row)) <= columns), `overflow at ${columns} columns`).toBe(true);
    }
  });

  it("renders assistant text wrapped to the terminal width", () => {
    const rows = renderMessage(msg({ content: "a".repeat(90) }), { columns: 40 });
    const text = rows.map((r) => strip(r));
    expect(text.some((line) => line.length <= 38 && line.startsWith("a"))).toBe(true);
    expect(rows[rows.length - 1]).toBe("");
  });

  it("restores the Ink-style settled Thinking block", () => {
    const collapsed = renderMessage(msg({ reasoning: "line one\nline two" }), { columns: 60 });
    expect(collapsed.map(strip)).toEqual(["  ✻ Thinking", "  line one", "  line two", ""]);
    expect(collapsed.join("\n")).not.toContain("└─");

    const expanded = renderMessage(msg({ reasoning: "line one" }), { columns: 60, showReasoning: true });
    expect(expanded.map(strip)).toEqual(["  ✻ Thinking", "  line one", ""]);
  });

  it("keeps long collapsed reasoning within every terminal width", () => {
    const reasoning = "We need answer user asks in Chinese: 你是啥模型. ".repeat(20);
    for (const columns of [24, 40, 80, 120, 256]) {
      const rows = renderMessage(msg({ reasoning }), { columns });
      expect(stringWidth(strip(rows[0]!))).toBeLessThanOrEqual(columns);
    }
    const wide = renderMessage(msg({ reasoning }), { columns: 256 }).map(strip).join("\n");
    expect(wide).toContain("Thinking");
    expect(wide).not.toContain("└─");
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

  it("keeps successful items and error details in a partially failed group", () => {
    const rows = renderMessage(msg({
      toolCalls: [
        { id: "ok", name: "read", args: { path: "good.ts" }, result: "ok", status: "completed" },
        { id: "bad", name: "read", args: { path: "bad.ts" }, result: "permission denied", isError: true, status: "failed" },
      ],
    }), { columns: 80 }).map(strip);
    const text = rows.join("\n");
    expect(text).toContain("good.ts");
    expect(text).toContain("bad.ts");
    expect(text).toContain("permission denied");
    expect(text).toContain("1 error");
  });

  it("shows the real Execute command below a description while running or failed", () => {
    const running = renderMessage(msg({
      toolCalls: [{
        id: "run",
        name: "bash",
        args: { command: "pwd", description: "check cwd" },
        status: "running",
      }],
    }), { columns: 80 }).map(strip).join("\n");
    expect(running).toContain("Execute check cwd running");
    expect(running).toContain("    pwd");

    const failed = renderMessage(msg({
      toolCalls: [{
        id: "fail",
        name: "bash",
        args: { command: "pwd", description: "check cwd" },
        status: "failed",
        result: "boom",
        isError: true,
      }],
    }), { columns: 80 }).map(strip).join("\n");
    expect(failed).toContain("Execute check cwd 1 error");
    expect(failed).toContain("    pwd");
    expect(failed).toContain("boom");
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
    const toolAt = text.indexOf("Read");
    const contentAt = text.indexOf("final answer");
    expect(reasoningAt).toBeLessThan(toolAt);
    expect(toolAt).toBeLessThan(contentAt);
  });

  it("keeps provider-turn Thinking while grouping Working per user request", () => {
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
    expect(text.match(/Thinking/g)).toHaveLength(2);
    expect(text).toContain("plan one");
    expect(text).toContain("plan two");
    expect(text.match(/Working/g)).toHaveLength(1);
    expect(text.indexOf("Execute")).toBeLessThan(text.indexOf("Read"));
    expect(text.indexOf("Read")).toBeLessThan(text.indexOf("done"));
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
    expect(text.indexOf("I will inspect.")).toBeLessThan(text.indexOf("Read"));
    expect(text.indexOf("Read")).toBeLessThan(text.indexOf("Result follows."));
  });

  it("wrapPlain honors explicit newlines and long words", () => {
    expect(wrapPlain("ab\ncd", 10)).toEqual(["ab", "cd"]);
    const wrapped = wrapPlain("aaaaaaaa bb", 8);
    expect(wrapped[0]).toBe("aaaaaaaa");
    expect(wrapped[1]).toBe("bb");
  });

  it("empty-content assistant with tools still renders the trace", () => {
    const rows = renderTranscript([msg({ content: "", toolCalls: [{ id: "t", name: "grep", args: {} }] })], { columns: 60 });
    expect(rows.some((r) => strip(r).includes("Search"))).toBe(true);
  });
});

describe("pi-tui welcome banner", () => {
  const data = {
    cwd: "~/bb/my-coding-agent-pi-tui",
    session: "session-123.jsonl",
    model: "deepseek-v4-pro",
    provider: "deepseek",
    thinking: "max",
  };

  it("restores the boxed product banner and live session metadata", () => {
    const rows = renderWelcomeBanner(data, 100).map(strip);
    const text = rows.join("\n");
    expect(text).toContain("Welcome to Bubble!");
    expect(text).toContain("I am a cat");
    expect(text).toContain("Directory:");
    expect(text).toContain("Session:");
    expect(text).toContain("Model:");
    expect(text).toContain("Version:");
    expect(rows.every((row) => stringWidth(row) <= 100)).toBe(true);
  });

  it("never overflows tiny terminals", () => {
    for (const width of [1, 4, 12, 23, 24, 40]) {
      const rows = renderWelcomeBanner(data, width);
      expect(rows.every((row) => stringWidth(strip(row)) <= width)).toBe(true);
    }
  });

  it("formats ordinary reasoning effort as part of the model unit", () => {
    expect(formatWelcomeModel(data)).toBe("deepseek-v4-pro with max effort · deepseek");
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

import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, TuiMainScreen, visibleWidth, type EditorTheme } from "@bubblebrain-ai/pi-tui";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { StreamingMessageComponent } from "../tui/components/streaming-message.js";
import { ResponsiveTranscriptComponent } from "../tui/components/responsive-transcript.js";
import { renderReasoning, type TranscriptTheme } from "../tui/components/transcript.js";
import { ResponsiveFooterComponent } from "../tui/footer.js";
import { createFlushScheduler } from "../tui/run.js";
import type { DisplayMessage } from "../tui/model/display-history.js";

const strip = (value: string): string => stripVTControlCharacters(value);

function rendered(component: StreamingMessageComponent, width = 80): string[] {
  return component.render(width).map((row) => strip(row).trimEnd());
}

afterEach(() => {
  vi.useRealTimers();
});

const plainTheme: TranscriptTheme = {
  userBg: (text) => text,
  userText: (text) => text,
  accent: (text) => text,
  dim: (text) => text,
  error: (text) => text,
  success: (text) => text,
};

const editorTheme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

describe("pi-tui working trace parity", () => {
  it("keeps live reasoning in a five-line Thinking window above the spinner", () => {
    const component = new StreamingMessageComponent();
    component.update({
      content: "",
      reasoning: "\nR1\n\nR2\nR3\nR4\nR5\nR6\nR7\n",
      tools: [],
      parts: [],
      phase: "thinking",
    }, 80);

    const rows = rendered(component);
    expect(rows).toContain("  ✻ Thinking…");
    expect(rows).toContain("  R3");
    expect(rows).toContain("  R7");
    expect(rows).not.toContain("  R1");
    expect(rows).not.toContain("  R2");
    expect(rows.indexOf("  ✻ Thinking…")).toBeLessThan(rows.findIndex((row) => row.includes("working through the request")));
    expect(rows.join("\n")).not.toContain("└─");
  });

  it("uses Ink state phrases and puts live output before status", () => {
    const component = new StreamingMessageComponent();

    component.update({ content: "", reasoning: "", tools: [], parts: [], phase: "thinking" }, 80);
    expect(rendered(component).at(-1)).toContain("mapping the workspace");

    component.update({
      content: "answer",
      reasoning: "thought",
      tools: [],
      parts: [{ type: "text", content: "answer" }],
      phase: "thinking",
    }, 80);
    let rows = rendered(component);
    expect(rows).toContain("  ✻ Thinking…");
    expect(rows).toContain("  thought");
    expect(rows.some((row) => row.includes("writing the response"))).toBe(true);
    expect(rows.findIndex((row) => row.includes("● answer"))).toBeLessThan(rows.findIndex((row) => row.includes("writing the response")));

    const read = { id: "read-1", name: "read", args: { path: "README.md" }, status: "running" as const };
    component.update({
      content: "answer",
      reasoning: "thought",
      tools: [read],
      parts: [{ type: "tools", toolCalls: [read] }, { type: "text", content: "answer" }],
      phase: "working",
    }, 80);
    rows = rendered(component);
    expect(rows.at(-1)).toContain("reading files");
    expect(rows.join("\n")).toContain("Working on Read 1 file");
    expect(rows.join("\n")).toContain("README.md");
    expect(rows.indexOf("  thought")).toBeLessThan(rows.findIndex((row) => row.includes("Working on Read")));
    expect(rows.findIndex((row) => row.includes("Working on Read"))).toBeLessThan(rows.findIndex((row) => row.includes("● answer")));
  });

  it("keeps ordered Thinking, commentary, full tool lifecycle, and answer trace", () => {
    const component = new StreamingMessageComponent();
    const pending = {
      id: "bash-1",
      name: "bash",
      args: {},
      rawArguments: '{"command":"npm test"}',
      status: "pending" as const,
    };
    component.update({
      content: "I will verify.Done.",
      reasoning: "inspect the tests",
      tools: [pending],
      parts: [
        { type: "text", content: "I will verify." },
        { type: "tools", toolCalls: [pending] },
        { type: "text", content: "Done." },
      ],
      phase: "working",
    }, 80);

    let text = rendered(component).join("\n");
    expect(text).toContain("✻ Thinking…");
    expect(text).toContain("Working on Execute npm test");
    expect(text).toContain("Execute npm test running");
    expect(text.indexOf("I will verify.")).toBeLessThan(text.indexOf("Execute npm test"));
    expect(text.indexOf("Execute npm test")).toBeLessThan(text.indexOf("Done."));

    const running = { ...pending, args: { command: "npm test" }, status: "running" as const, result: "42 tests passed" };
    component.update({
      content: "I will verify.",
      reasoning: "inspect the tests",
      tools: [running],
      parts: [{ type: "text", content: "I will verify." }, { type: "tools", toolCalls: [running] }],
      phase: "working",
    }, 80);
    text = rendered(component).join("\n");
    expect(text).toContain("Working on Execute npm test");
    expect(text).toContain("42 tests passed");

    const completed = { ...running, status: "completed" as const };
    component.update({
      content: "Done.",
      reasoning: "inspect the tests",
      tools: [completed],
      parts: [{ type: "tools", toolCalls: [completed] }, { type: "text", content: "Done." }],
      phase: "working",
    }, 80);
    text = rendered(component).join("\n");
    expect(text).not.toContain("Working on Execute");
    expect(text).not.toContain(" running");
    expect(text).toContain("1 line output · Ctrl+O to view");
    expect(text).toContain("✻ Thinking…");
  });

  it("rotates the spinner and idle phrase on the Ink cadence, then cleans up", () => {
    vi.useFakeTimers();
    const component = new StreamingMessageComponent();
    component.update({ content: "", reasoning: "", tools: [], parts: [], phase: "thinking" }, 80);
    component.startSpinner();
    const initial = rendered(component).at(-1)!;

    vi.advanceTimersByTime(100);
    const nextFrame = rendered(component).at(-1)!;
    expect(nextFrame).not.toBe(initial);

    vi.advanceTimersByTime(1_400);
    expect(rendered(component).at(-1)).toContain("reading the room");

    component.clearToNothing();
    expect(rendered(component)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders settled reasoning as the first two non-empty lines without a connector", () => {
    const compact = renderReasoning("\nR1\n\nR2\nR3\nR4", { columns: 80 }).map(strip);
    expect(compact).toEqual([
      "  ✻ Thinking",
      "  R1",
      "  R2",
      "  … (Ctrl+T to expand)",
      "",
    ]);
    expect(compact.join("\n")).not.toContain("└─");
  });

  it("keeps every live and settled trace row within the terminal width", () => {
    for (const width of [1, 4, 12, 20, 40, 80]) {
      const component = new StreamingMessageComponent();
      component.update({
        content: "",
        reasoning: "这是非常长的中文 reasoning 🫧\n第二行也很长 🚦",
        tools: [{
          id: "bash-wide",
          name: "bash",
          args: { command: "npm test -- --run 这是非常长的命令参数 🚦" },
          status: "running",
          result: "这是非常长的运行结果 🫧",
        }],
        parts: [{
          type: "tools",
          toolCalls: [{
            id: "bash-wide",
            name: "bash",
            args: { command: "npm test -- --run 这是非常长的命令参数 🚦" },
            status: "running",
            result: "这是非常长的运行结果 🫧",
          }],
        }],
        phase: "thinking",
      }, width);
      expect(component.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(renderReasoning("这是非常长的中文 reasoning 🫧\n第二行", { columns: width })
        .every((row) => visibleWidth(row) <= width)).toBe(true);
    }
  });

  it("orders user, live Thinking, spinner, composer and footer in the current viewport", async () => {
    const terminal = new VirtualTerminal(80, 18);
    const tui = new TuiMainScreen(terminal);
    let messages: DisplayMessage[] = [{ key: "user", role: "user", content: "TRACE_USER_MARKER" }];
    const transcript = new ResponsiveTranscriptComponent(() => ({ messages, options: { theme: plainTheme } }));
    const streaming = new StreamingMessageComponent();
    streaming.update({ content: "", reasoning: "TRACE_LIVE_REASONING", tools: [], parts: [], phase: "thinking" }, 80);
    const editor = new Editor(tui, editorTheme);
    const footer = new ResponsiveFooterComponent(() => ({
      agent: { model: "TRACE_FOOTER", getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }) },
      cwd: "~/trace",
    }));
    tui.addChild(transcript);
    tui.addChild(streaming);
    tui.addChild(editor);
    tui.addChild(footer);
    tui.setFocus(editor);
    tui.start();
    terminal.sendInput("Q");
    await terminal.waitForRender();

    let viewport = terminal.getViewport();
    const userAt = viewport.findIndex((row) => row.includes("TRACE_USER_MARKER"));
    const thinkingAt = viewport.findIndex((row) => row.includes("✻ Thinking"));
    const spinnerAt = viewport.findIndex((row) => row.includes("working through the request"));
    const composerAt = viewport.findIndex((row) => row.includes("Q"));
    const footerAt = viewport.findIndex((row) => row.includes("TRACE_FOOTER"));
    expect([userAt, thinkingAt, spinnerAt, composerAt, footerAt].every((index) => index >= 0)).toBe(true);
    expect(userAt).toBeLessThan(thinkingAt);
    expect(thinkingAt).toBeLessThan(spinnerAt);
    expect(spinnerAt).toBeLessThan(composerAt);
    expect(composerAt).toBeLessThan(footerAt);

    terminal.resize(20, 5);
    const narrowTool = {
      id: "narrow",
      name: "bash",
      args: { command: "npm test -- --run very-long-command" },
      status: "running" as const,
      result: "still running",
    };
    streaming.update({
      content: "TRACE_LIVE_ANSWER",
      reasoning: "TRACE_LIVE_REASONING",
      tools: [narrowTool],
      parts: [{ type: "tools", toolCalls: [narrowTool] }, { type: "text", content: "TRACE_LIVE_ANSWER" }],
      phase: "working",
    }, 20);
    terminal.sendInput("R");
    await terminal.waitForRender();
    expect(tui.getFocusedComponent()).toBe(editor);
    expect(editor.getText()).toBe("QR");
    expect(terminal.getViewport().some((row) => row.includes("QR"))).toBe(true);
    expect(streaming.render(20).every((row) => visibleWidth(row) <= 20)).toBe(true);

    terminal.resize(80, 18);
    await terminal.waitForRender();

    messages = [...messages, {
      key: "assistant",
      role: "assistant",
      content: "TRACE_SETTLED_ANSWER",
      reasoning: "TRACE_SETTLED_REASONING",
    }];
    streaming.clearToNothing();
    tui.requestRender();
    await terminal.waitForRender();
    viewport = terminal.getViewport();
    expect(viewport.some((row) => row.includes("TRACE_SETTLED_ANSWER"))).toBe(true);
    expect(viewport.some((row) => row.includes("mapping the workspace") || row.includes("working through the request"))).toBe(false);
    expect(viewport.some((row) => row.includes("└─"))).toBe(false);
    tui.stop();
  });
});

describe("production streaming flush scheduler", () => {
  it("coalesces a burst, allows the next burst, and cancels pending work", () => {
    vi.useFakeTimers();
    const scheduler = createFlushScheduler();
    const first = vi.fn();
    for (let index = 0; index < 10; index += 1) scheduler.scheduleFlush(40, first);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(40);
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    scheduler.scheduleFlush(40, second);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.cancelFlush();
    scheduler.cancelFlush();
    vi.advanceTimersByTime(40);
    expect(second).not.toHaveBeenCalled();
  });
});

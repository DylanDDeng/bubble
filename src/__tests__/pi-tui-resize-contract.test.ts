/**
 * Terminal-level invariants for the vendored pi-tui main-screen renderer.
 *
 * These are the renderer-level gates the Ink TUI kept violating via its
 * `<Static>` + full-clear compensation path (duplicate transcript in
 * scrollback, blank bands, wrapped full-width rows on narrow panes). Before
 * building Bubble product UI on this renderer we pin its resize contract:
 *
 *  1. append-only content commits each settled row to scrollback exactly once
 *  2. narrowing the terminal never leaves a physical row wider than the
 *     terminal (no reflow of committed scrollback)
 *  3. live-region collapse (streaming oscillation) does not rewind the
 *     scrollback anchor
 *  4. widening re-renders in place without duplicating committed rows
 *  5. cursor bookkeeping stays within the terminal after resizes
 *
 * Uses the upstream VirtualTerminal (xterm-headless) exactly like the
 * renderer's own suite does, so failures here are renderer facts, not
 * Bubble-abstraction bugs.
 */
import { describe, expect, it } from "vitest";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { Editor, TuiMainScreen, Text, type Component, type EditorTheme, type TUI } from "@bubblebrain-ai/pi-tui";
import { ResponsiveTranscriptComponent } from "../tui/components/responsive-transcript.js";
import type { TranscriptTheme } from "../tui/components/transcript.js";
import { ResponsiveFooterComponent } from "../tui/footer.js";

class TranscriptComponent implements Component {
  lines: string[] = [];
  render(_width: number): string[] {
    return this.lines;
  }
  invalidate(): void {}
}

function start(columns = 80, rows = 24): { terminal: VirtualTerminal; tui: TUI } {
  const terminal = new VirtualTerminal(columns, rows);
  const tui: TUI = new TuiMainScreen(terminal);
  tui.start();
  return { terminal, tui };
}

const TEST_USER_BG = 0x22354a;
const coloredTheme: TranscriptTheme = {
  userBg: (text) => `\u001b[48;2;34;53;74m${text}\u001b[49m`,
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

const footerAgent = {
  model: "resize-model",
  getContextUsageSnapshot: () => ({ usedTokens: 123, contextWindow: 10_000 }),
};

function paintedCells(terminal: VirtualTerminal, row: number): number {
  const xterm = (terminal as unknown as { xterm: XtermTerminal }).xterm;
  const buffer = xterm.buffer.active;
  const line = buffer.getLine(buffer.viewportY + row);
  let count = 0;
  for (let column = 0; column < terminal.columns; column += 1) {
    if (line?.getCell(column)?.getBgColor() === TEST_USER_BG) count += 1;
  }
  return count;
}

describe("pi-tui main-screen resize contract", () => {
  it("commits appended rows to scrollback exactly once", async () => {
    const { terminal, tui } = start();
    const component = new TranscriptComponent();
    tui.addChild(component);

    component.lines = ["row-1", "row-2", "row-3"];
    tui.requestRender();
    await terminal.waitForRender();

    const scroll = terminal.getScrollBuffer().filter((line) => line.includes("row-"));
    expect(scroll).toHaveLength(3);
  });

  it("narrows without leaving rows wider than the terminal", async () => {
    const { terminal, tui } = start(120, 40);
    const component = new TranscriptComponent();
    tui.addChild(component);

    component.lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    tui.requestRender();
    await terminal.waitForRender();

    terminal.resize(30, 16);
    tui.requestRender(true);
    await terminal.waitForRender();

    for (const line of terminal.getViewport()) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it("does not duplicate committed rows when widening", async () => {
    const { terminal, tui } = start(40, 24);
    const component = new TranscriptComponent();
    tui.addChild(component);

    component.lines = ["alpha", "beta", "gamma"];
    tui.requestRender();
    await terminal.waitForRender();

    terminal.resize(100, 30);
    tui.requestRender(true);
    await terminal.waitForRender();

    const all = terminal.getScrollBuffer().join("\n");
    expect(all.match(/alpha/g)?.length ?? 0).toBe(1);
    expect(all.match(/gamma/g)?.length ?? 0).toBe(1);
  });

  it("repaints a user card to the new width instead of preserving old ANSI padding", async () => {
    const { terminal, tui } = start(40, 12);
    const transcript = new ResponsiveTranscriptComponent(() => ({
      messages: [{ key: "u", role: "user", content: "你好 resize should reflow" }],
      options: { theme: coloredTheme },
    }));
    tui.addChild(transcript);
    tui.requestRender();
    await terminal.waitForRender();

    expect([0, 1, 2].map((row) => paintedCells(terminal, row))).toEqual([38, 38, 38]);

    terminal.resize(60, 12);
    tui.requestRender(true);
    await terminal.waitForRender();
    expect([0, 1, 2].map((row) => paintedCells(terminal, row))).toEqual([58, 58, 58]);

    terminal.resize(24, 12);
    tui.requestRender(true);
    await terminal.waitForRender();
    const paintedRows = [0, 1, 2, 3].map((row) => paintedCells(terminal, row));
    expect(paintedRows.every((count) => count === 22)).toBe(true);
  });

  it("renders a long settled Thinking row without terminating the TUI", async () => {
    const terminal = new VirtualTerminal(256, 30);
    const tui = new TuiMainScreen(terminal);
    const transcript = new ResponsiveTranscriptComponent(() => ({
      messages: [{
        key: "assistant",
        role: "assistant",
        content: "我是 Kimi。",
        reasoning: "We need answer user asks in Chinese: 你是啥模型. ".repeat(20),
      }],
      options: { theme: coloredTheme },
    }));
    tui.addChild(transcript);
    tui.start();

    expect(() => tui.renderNow()).not.toThrow();
    await terminal.flush();
    expect(terminal.getScrollBuffer().some((line) => line.includes("Thinking"))).toBe(true);
    expect(terminal.getViewport().some((line) => line.includes("我是 Kimi。"))).toBe(true);
    tui.stop();
  });

  it("keeps focused composer input visible after shrinking from 140x45 to 20x5", async () => {
    const terminal = new VirtualTerminal(140, 45);
    const tui = new TuiMainScreen(terminal);
    const editor = new Editor(tui, editorTheme);
    const footer = new ResponsiveFooterComponent(() => ({
      agent: footerAgent,
      cwd: "~/very/long/working/directory/项目🫧",
      extra: ["queue ×12", "steer ×3"],
    }));
    tui.addChild(new Text("commands: /help rendered at the original width"));
    tui.addChild(editor);
    tui.addChild(footer);
    tui.setFocus(editor);
    tui.start();
    await terminal.waitForRender();

    terminal.resize(20, 5);
    await terminal.waitForRender();
    terminal.sendInput("Q");
    await terminal.waitForRender();

    expect(tui.getFocusedComponent()).toBe(editor);
    expect(editor.getText()).toContain("Q");
    expect(terminal.getViewport().some((line) => line.includes("Q"))).toBe(true);
    expect(footer.render(20)).toHaveLength(1);
    tui.stop();
  });

  it("keeps an edited multiline cursor row visible in a 20x6 viewport", async () => {
    const terminal = new VirtualTerminal(140, 45);
    const tui = new TuiMainScreen(terminal);
    const editor = new Editor(tui, editorTheme);
    const footer = new ResponsiveFooterComponent(() => ({ agent: footerAgent }));
    tui.addChild(editor);
    tui.addChild(footer);
    tui.setFocus(editor);
    tui.start();
    editor.setText(Array.from({ length: 20 }, (_, index) => `draft-${String(index + 1).padStart(2, "0")}`).join("\n"));
    await terminal.waitForRender();

    terminal.resize(20, 6);
    await terminal.waitForRender();
    for (let index = 0; index < 17; index += 1) terminal.sendInput("\x1b[A");
    terminal.sendInput("Z");
    await terminal.waitForRender();

    expect(tui.getFocusedComponent()).toBe(editor);
    expect(editor.getText()).toContain("Z");
    expect(terminal.getViewport().some((line) => line.includes("Z"))).toBe(true);
    tui.stop();
  });

  it("keeps live-region collapse from rewinding scrollback", async () => {
    const { terminal, tui } = start(80, 24);
    const component = new TranscriptComponent();
    tui.addChild(component);

    component.lines = ["settled-1", "settled-2"];
    tui.requestRender();
    await terminal.waitForRender();

    // Streaming oscillation: content grows then shrinks.
    component.lines = ["settled-1", "settled-2", "stream-a", "stream-b"];
    tui.requestRender();
    await terminal.waitForRender();
    component.lines = ["settled-1", "settled-2", "stream-a"];
    tui.requestRender();
    await terminal.waitForRender();

    const all = terminal.getScrollBuffer().join("\n");
    // Every settled row appears exactly once — collapse never repaints
    // already-committed rows back into scrollback.
    expect(all.match(/settled-1/g)?.length ?? 0).toBe(1);
    expect(all.match(/settled-2/g)?.length ?? 0).toBe(1);
  });

  it("keeps the cursor inside the terminal after resize", async () => {
    const { terminal, tui } = start(80, 24);
    tui.addChild(new Text("hello"));
    tui.requestRender();
    await terminal.waitForRender();

    terminal.resize(20, 8);
    tui.requestRender(true);
    await terminal.waitForRender();

    const { x, y } = terminal.getCursorPosition();
    // 0-indexed: legal positions span [0, cols]/[0, rows] where cols means
    // the wrap-pending cell. Anything beyond that is a desync.
    expect(x).toBeLessThanOrEqual(20);
    expect(y).toBeLessThanOrEqual(8);
  });
});

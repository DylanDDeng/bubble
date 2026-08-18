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
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { TuiMainScreen, Text, type Component, type TUI } from "@bubblebrain-ai/pi-tui";

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

import { describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { PiTuiApp } from "../tui/app.js";
import { TaskInspectorComponent } from "../tui/components/task-inspector.js";
import type { DisplayMessage } from "../tui/model/display-history.js";
import { paletteFor } from "../tui/model/theme.js";

class RecordingTerminal extends VirtualTerminal {
  writes: string[] = [];

  override write(data: string): void {
    this.writes.push(data);
    super.write(data);
  }
}

describe("pi-tui runtime theme", () => {
  it("applies /theme immediately and persists exactly the selected mode", async () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    const terminal = new RecordingTerminal(90, 28);
    const messages: DisplayMessage[] = [];
    const onThemeModeChange = vi.fn();
    const onThemeToggle = vi.fn();
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => messages,
      getSubagentGroups: () => [],
      getWorkflows: () => [],
      getBackgroundTasks: () => [],
      isRunning: () => false,
      getStreamingTail: () => null,
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => false,
      runTurn: async () => {},
      appendDisplayMessage: (message: DisplayMessage) => { messages.push(message); },
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const app = new PiTuiApp({
      agent: {
        model: "test-model",
        providerId: "test-provider",
        thinking: "off",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: { getSessionFile: () => "/theme.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle,
        onThemeModeChange,
      },
      terminal,
      themeMode: "auto",
      detectedTheme: "dark",
    });

    app.start();
    try {
      terminal.sendInput("/theme ");
      await vi.waitFor(() => {
        const viewport = terminal.getViewport().join("\n");
        expect(viewport).toContain("Auto");
        expect(viewport).toContain("Light");
        expect(viewport).toContain("Dark");
      });
      terminal.sendInput("light");
      terminal.sendInput("\x1b");
      terminal.writes.length = 0;
      terminal.sendInput("\r");
      await vi.waitFor(() => expect(onThemeModeChange).toHaveBeenCalledWith("light"));
      await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("Theme set to light"));
      const repaint = terminal.writes.join("");
      expect(repaint).toContain("\x1b[48;2;252;252;250m\x1b[2K");
      expect(repaint).toContain("\x1b[38;2;185;189;184m");
      expect(onThemeModeChange).toHaveBeenCalledTimes(1);
      expect(onThemeToggle).not.toHaveBeenCalled();
    } finally {
      app.dispose();
      chalk.level = previousLevel;
    }
  });

  it("keeps an already-open panel attached to the live palette object", () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const palette = paletteFor("dark");
      const panel = new TaskInspectorComponent({
        id: "task",
        title: "Theme probe",
        getStatus: () => "running",
        getOutput: () => "output",
        getTerminalRows: () => 10,
        onClose: () => {},
        onStop: () => {},
        onRender: () => {},
        theme: palette,
      });
      const before = panel.render(50).join("\n");

      Object.assign(palette, paletteFor("light"));
      const after = panel.render(50).join("\n");

      expect(after).not.toBe(before);
      expect(after).toContain("\x1b[38;2;185;189;184m");
    } finally {
      chalk.level = previousLevel;
    }
  });
});

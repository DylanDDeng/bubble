import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { stripTerminalSequences } from "@bubblebrain-ai/pi-tui";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { SessionManager } from "../session.js";
import { PiTuiApp } from "../tui/app.js";
import { projectTranscript } from "../tui/components/transcript.js";
import {
  RewindPickerComponent,
  type RewindPickerPoint,
} from "../tui/components/rewind-picker.js";
import type { DisplayMessage } from "../tui/model/display-history.js";
import { darkTheme } from "../tui/model/theme.js";

let fixtureCounter = 0;

function points(): RewindPickerPoint[] {
  return [
    { turnIndex: 0, fileCount: 0, turn: { id: "1", text: "first", preview: "first prompt", timestamp: 1 } },
    { turnIndex: 1, fileCount: 2, turn: { id: "2", text: "second", preview: "second prompt", timestamp: 2 } },
  ];
}

describe("Grok-style rewind picker", () => {
  it("renders newest-first on a filled, accent-railed prompt surface", () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const component = new RewindPickerComponent("picker", points(), {
        getTerminalRows: () => 24,
        onPreview: () => {},
        onScopeChange: () => {},
        onCancel: () => {},
        onCancelRun: () => {},
        onConfirm: () => {},
        onRender: () => {},
      });
      const rows = component.render(72);
      const plain = rows.map(stripTerminalSequences);

      expect(plain[0]).toContain("Rewind to which turn?");
      expect(plain[2]).toContain("second prompt");
      expect(plain[3]).toContain("first prompt");
      expect(rows.every((row) => stripTerminalSequences(row).startsWith("▎"))).toBe(true);
      const selectedRgb = darkTheme.traceSelectedBg
        .slice(1)
        .match(/../g)!
        .map((part) => Number.parseInt(part, 16))
        .join(";");
      expect(rows[2]).toContain(`48;2;${selectedRgb}`);
      expect(plain[2]?.length).toBe(72);
    } finally {
      chalk.level = previousLevel;
    }
  });

  it("previews on keyboard/mouse selection, cycles scope, and confirms", () => {
    const previews: Array<{ id: string; scope: string }> = [];
    const confirmed = vi.fn();
    const component = new RewindPickerComponent("picker", points(), {
      getTerminalRows: () => 24,
      onPreview: (point, scope) => previews.push({ id: point.turn.id, scope }),
      onScopeChange: (point, scope) => previews.push({ id: point?.turn.id ?? "none", scope }),
      onCancel: () => {},
      onCancelRun: () => {},
      onConfirm: confirmed,
      onRender: () => {},
    });

    component.handleInput("j");
    component.handleInput("l");
    expect(previews).toContainEqual({ id: "1", scope: "all" });
    expect(previews).toContainEqual({ id: "1", scope: "chat" });

    component.handleInput("\r");
    component.handleInput("\r");
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({ turnIndex: 0 }), "chat");

    const mouseComponent = new RewindPickerComponent("picker", points(), {
      getTerminalRows: () => 24,
      onPreview: () => {},
      onScopeChange: () => {},
      onCancel: () => {},
      onCancelRun: () => {},
      onConfirm: confirmed,
      onRender: () => {},
    });
    mouseComponent.render(72);
    expect(mouseComponent.handleMouse({ kind: "move", button: 35, x: 5, y: 3, release: false, clickCount: 1 })).toBe(true);
    expect(mouseComponent.getSelectedPoint()?.turn.id).toBe("1");
  });

  it("dims exactly the transcript tail that the selected conversation rewind will remove", () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const projection = projectTranscript([
        { key: "keep", role: "assistant", content: "keep this" },
        { key: "drop", role: "user", content: "drop from here" },
        { key: "drop-answer", role: "assistant", content: "drop this too" },
      ], { columns: 60, dimFromMessageIndex: 1, trailingSpacer: false });
      const keepRow = projection.rows.find((row) => stripTerminalSequences(row).includes("keep this"))!;
      const dropRow = projection.rows.find((row) => stripTerminalSequences(row).includes("drop this too"))!;
      expect(keepRow).not.toContain("\x1b[2m");
      expect(dropRow).toContain("\x1b[2m");
    } finally {
      chalk.level = previousLevel;
    }
  });

  it("replaces the composer, confirms, restores the prompt, and removes the rewound tail", async () => {
    const dir = join(tmpdir(), `bubble-tui-rewind-${Date.now()}-${fixtureCounter++}`);
    mkdirSync(dir, { recursive: true });
    const session = new SessionManager(join(dir, "session.jsonl"));
    session.appendMessage({ role: "user", content: "first prompt" });
    session.appendMessage({ role: "assistant", content: "first answer" });
    session.appendMessage({ role: "user", content: "second prompt" });
    session.appendMessage({ role: "assistant", content: "second answer" });
    let transcript: DisplayMessage[] = [
      { key: "u1", role: "user", content: "first prompt" },
      { key: "a1", role: "assistant", content: "first answer" },
      { key: "u2", role: "user", content: "second prompt" },
      { key: "a2", role: "assistant", content: "second answer" },
    ];
    const listeners = new Set<() => void>();
    const controller = {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getTranscript: () => transcript,
      getSessionManager: () => session,
      getSubagentGroups: () => [],
      getWorkflows: () => [],
      getBackgroundTasks: () => [],
      isRunning: () => false,
      getStreamingTail: () => null,
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      cancelActiveRun: () => false,
      runTurn: async () => {},
      steer: () => false,
      clearTranscript: () => { transcript = []; },
      rebuildTranscriptFromAgent: () => {},
      rewindToTurn: async (targetId: string, scope: string) => {
        const target = session.listUserTurns().find((turn) => turn.id === targetId)!;
        transcript = transcript.slice(0, 2);
        for (const listener of listeners) listener();
        return {
          target,
          scope,
          files: { restored: [], deleted: [], failed: [] },
          removedEntries: 2,
        };
      },
      appendDisplayMessage: (message: DisplayMessage) => {
        transcript = [...transcript, message];
        for (const listener of listeners) listener();
      },
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const terminal = new VirtualTerminal(80, 20);
    const app = new PiTuiApp({
      agent: {
        messages: [],
        model: "test-model",
        providerId: "test-provider",
        thinking: "medium",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: session,
      controller: controller as never,
      callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
      terminal,
    });

    app.start();
    try {
      terminal.sendInput("/rewind");
      terminal.sendInput("\x1b");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Rewind to which turn?");
      expect(terminal.getViewport().join("\n")).toContain("second prompt");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Rewind to “second prompt”?");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      const screen = terminal.getViewport().join("\n");
      expect(screen).toContain("Reverted conversation");
      expect(screen).not.toContain("second answer");
      expect(screen).toContain("second prompt");
    } finally {
      app.dispose();
    }
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stripTerminalSequences,
  visibleWidth,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { SessionManager, type SessionSummary } from "../session.js";
import { PiTuiApp } from "../tui/app.js";
import { SessionPickerComponent } from "../tui/components/session-picker.js";

const originalBubbleHome = process.env.BUBBLE_HOME;

afterEach(() => {
  if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
  else process.env.BUBBLE_HOME = originalBubbleHome;
});

function summary(name: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    file: `/sessions/${name}.jsonl`,
    name,
    cwd: "/project",
    cwdLabel: "/project",
    title: `${name} title`,
    preview: `${name} preview`,
    firstUserMessage: `${name} preview`,
    messageCount: 4,
    mtime: Date.now(),
    ...overrides,
  };
}

function plain(lines: string[]): string {
  return lines.map(stripTerminalSequences).join("\n");
}

describe("SessionPickerComponent", () => {
  it("renders fresh/current/other sessions and switches scopes from the keyboard", () => {
    const active = summary("active");
    const other = summary("other", { mtime: active.mtime - 1_000 });
    const remote = summary("remote", { cwd: "/elsewhere", cwdLabel: "/elsewhere" });
    const onSelect = vi.fn();
    const onNewSession = vi.fn();
    const onClose = vi.fn();
    const panel = new SessionPickerComponent({
      currentCwd: "/project",
      currentSessions: [active, other],
      allSessions: [active, other, remote],
      activeFile: active.file,
      getTerminalRows: () => 30,
      onSelect,
      onNewSession,
      onClose,
      onRender: vi.fn(),
    });

    let rows = panel.render(90);
    expect(rows.every((row) => visibleWidth(row) <= 90)).toBe(true);
    expect(plain(rows)).toContain("＋ New session");
    expect(plain(rows)).toContain("active title");
    expect(plain(rows)).toContain("current");
    expect(plain(rows)).not.toContain("remote title");

    panel.handleInput("\t");
    rows = panel.render(90);
    expect(plain(rows)).toContain("remote title");

    panel.handleInput("\x1b[H");
    panel.handleInput("\r");
    expect(onNewSession).toHaveBeenCalledTimes(1);
    panel.handleInput("\x1b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports full-row hover/click selection", () => {
    const active = summary("active");
    const other = summary("other");
    const onSelect = vi.fn();
    const panel = new SessionPickerComponent({
      currentCwd: "/project",
      currentSessions: [active, other],
      allSessions: [active, other],
      activeFile: active.file,
      getTerminalRows: () => 30,
      onSelect,
      onNewSession: vi.fn(),
      onClose: vi.fn(),
      onRender: vi.fn(),
    });
    const rows = panel.render(80).map(stripTerminalSequences);
    const row = rows.findIndex((line) => line.includes("other title"));
    expect(row).toBeGreaterThan(0);
    const mouse = (kind: "move" | "press"): TuiMouseEvent => ({
      kind,
      button: kind === "move" ? 35 : 0,
      x: 8,
      y: row,
      release: false,
      clickCount: 1,
    });
    expect(panel.handleMouse(mouse("move"))).toBe(true);
    expect(panel.handleMouse(mouse("press"))).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(other.file);
  });
});

describe("/session Pi TUI integration", () => {
  it("opens the centered browser, resumes a session, and starts a fresh one", async () => {
    process.env.BUBBLE_HOME = mkdtempSync(join(tmpdir(), "bubble-tui-sessions-"));
    const cwd = process.cwd();
    const first = SessionManager.create(cwd, "first.jsonl");
    first.updateMetadata({ cwd, title: "First conversation" });
    first.appendMessage({ role: "user", content: "first question" });
    const second = SessionManager.create(cwd, "second.jsonl");
    second.updateMetadata({ cwd, title: "Second conversation" });
    second.appendMessage({ role: "user", content: "second question" });

    let active = first;
    const switchSession = vi.fn((plan: { targetFile: string }) => {
      active = new SessionManager(plan.targetFile);
      return { ok: true };
    });
    const createFreshSession = vi.fn(() => {
      active = SessionManager.createFresh(cwd);
      active.getOrCreatePromptCacheKey();
      return { ok: true };
    });
    const terminal = new VirtualTerminal(100, 30);
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      getSessionManager: () => active,
      getSubagentGroups: () => [],
      getWorkflows: () => [],
      getBackgroundTasks: () => [],
      isRunning: () => false,
      isBusy: () => false,
      getStreamingTail: () => null,
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => false,
      runTurn: async () => {},
      appendDisplayMessage: () => {},
      clearTranscript: () => {},
      switchSession,
      createFreshSession,
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const app = new PiTuiApp({
      agent: {
        messages: [],
        model: "test:model",
        providerId: "test",
        thinking: "off",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: first,
      controller: controller as never,
      callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
      terminal,
    });

    app.start();
    try {
      await (app as unknown as { handleCommand(command: string): Promise<void> }).handleCommand("/session");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Current project");
      expect(terminal.getViewport().join("\n")).toContain("＋ New session");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(switchSession).toHaveBeenCalledWith(expect.objectContaining({ targetFile: second.getSessionFile() }));
      expect(active.getSessionFile()).toBe(second.getSessionFile());

      await (app as unknown as { handleCommand(command: string): Promise<void> }).handleCommand("/session");
      await terminal.waitForRender();
      terminal.sendInput("\x1b[H");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(createFreshSession).toHaveBeenCalledWith(cwd);
      expect(active.getSessionFile()).not.toBe(second.getSessionFile());
      expect((app as unknown as { tui: { hasOverlay(): boolean } }).tui.hasOverlay()).toBe(false);
    } finally {
      app.dispose();
    }
  });
});

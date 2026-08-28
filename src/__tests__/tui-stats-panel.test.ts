import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import {
  stripTerminalSequences,
  visibleWidth,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import type { StatsRange, UsageStats, UsageStatsBundle } from "../stats/usage.js";
import { PiTuiApp } from "../tui/app.js";
import { StatsPanelComponent } from "../tui/components/stats-panel.js";

function usage(range: StatsRange, days: number): UsageStats {
  const daily = Array.from({ length: days }, (_value, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    active: index % 2 === 0,
    tokens: index % 2 === 0 ? (index + 1) * 1_000 : 0,
    hasPreciseUsage: index % 2 === 0,
  }));
  const activityCells = [daily[0], daily[10], daily[20], daily[28], undefined, undefined, undefined];
  return {
    range,
    days,
    startDate: range === "7d" ? "2026-08-17" : "2026-07-25",
    endDate: "2026-08-23",
    daily,
    heatmap: [{ label: "08/17", cells: activityCells }],
    models: [{
      model: "openai-codex:gpt-5.6-sol",
      displayName: "openai-codex:gpt-5.6-sol",
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      turns: 12,
      promptTokens: 120_000,
      completionTokens: 20_000,
      promptCacheHitTokens: 40_000,
      promptCacheMissTokens: 80_000,
      cacheCreationTokens: 0,
      reasoningTokens: 5_000,
      totalTokens: 140_000,
      cost: 1.25,
      costCurrency: "USD",
    }],
    totalTokens: 140_000,
    trackedCosts: { USD: 1.25 },
    trackedCost: 1.25,
    trackedCostCurrency: "USD",
    activeDays: daily.filter((day) => day.active).length,
    sessionsScanned: 4,
    sessionsWithoutTokenData: 1,
  };
}

function bundle(): UsageStatsBundle {
  return {
    generatedAt: new Date("2026-08-23T12:34:00"),
    ranges: {
      "7d": usage("7d", 7),
      "30d": usage("30d", 30),
    },
  };
}

function panel(rows = 40) {
  const onClose = vi.fn();
  const onRender = vi.fn();
  return {
    instance: new StatsPanelComponent(bundle(), {
      getTerminalRows: () => rows,
      onClose,
      onRender,
    }),
    onClose,
    onRender,
  };
}

const textOf = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

describe("StatsPanelComponent", () => {
  it("renders the /context-style framed 30-day usage view", () => {
    const { instance } = panel();
    const lines = instance.render(90);
    const text = textOf(lines);

    expect(lines).toHaveLength(30);
    expect(lines.every((line) => visibleWidth(line) <= 90)).toBe(true);
    expect(text).toContain("Last 7 days");
    expect(text).toContain("Last 30 days");
    expect(text).toContain("2026-07-25 – 2026-08-23");
    expect(text).toContain("Activity");
    expect(text).toContain("Less · ○ ◉ ● More");
    expect(text).toContain("Model usage");
    expect(text).toContain("Summary");
    expect(text).toContain("12 turns");
    expect(text).toContain("Tracked cost $1.25");
  });

  it("uses the Bubble palette and distinct shapes for activity intensity", () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const { instance } = panel();
      const rendered = instance.render(90).join("\n");
      expect(rendered).toContain("\x1b[36m◉");
      expect(rendered).toContain("\x1b[35m●");
      expect(textOf(instance.render(90))).toContain("Less · ○ ◉ ● More");
    } finally {
      chalk.level = previousLevel;
    }
  });

  it("uses available panel width to render full model names", () => {
    const data = bundle();
    const fullName = "bailian-token-plan:qwen3.8-coder-ultra";
    data.ranges["30d"].models[0] = {
      ...data.ranges["30d"].models[0]!,
      model: fullName,
      displayName: fullName,
    };
    const instance = new StatsPanelComponent(data, {
      getTerminalRows: () => 40,
      onClose: () => {},
      onRender: () => {},
    });

    expect(textOf(instance.render(100))).toContain(fullName);
  });

  it("switches ranges, scrolls, and closes from the keyboard", () => {
    const { instance, onClose, onRender } = panel(18);
    instance.render(80);

    instance.handleInput("\x1b[D");
    expect(textOf(instance.render(80))).toContain("2026-08-17 – 2026-08-23");
    instance.handleInput("\x1b[C");
    expect(textOf(instance.render(80))).toContain("2026-07-25 – 2026-08-23");
    instance.handleInput("G");
    expect(onRender).toHaveBeenCalled();
    instance.handleInput("\x1b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports hover, tab selection, and the mouse close target", () => {
    const { instance, onClose } = panel();
    instance.render(80);
    const move = (x: number, y: number): TuiMouseEvent => ({
      kind: "move",
      button: 35,
      x,
      y,
      release: false,
      clickCount: 1,
    });
    const click = (x: number, y: number): TuiMouseEvent => ({
      kind: "press",
      button: 0,
      x,
      y,
      release: false,
      clickCount: 1,
    });

    expect(instance.handleMouse(move(4, 1))).toBe(true);
    expect(instance.handleMouse(click(4, 1))).toBe(true);
    expect(textOf(instance.render(80))).toContain("2026-08-17 – 2026-08-23");
    expect(instance.handleMouse(click(76, 0))).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("expands and collapses all models from the mouse or m shortcut", () => {
    const data = bundle();
    const first = data.ranges["30d"].models[0]!;
    data.ranges["30d"].models = Array.from({ length: 8 }, (_value, index) => ({
      ...first,
      model: `provider:model-${index + 1}`,
      displayName: `provider:model-${index + 1}`,
      turns: 12 + index,
      totalTokens: 140_000 - index * 10_000,
      cost: index === 0 ? 1.25 : undefined,
    }));
    data.ranges["30d"].totalTokens = data.ranges["30d"].models
      .reduce((sum, model) => sum + model.totalTokens, 0);
    const onRender = vi.fn();
    const instance = new StatsPanelComponent(data, {
      getTerminalRows: () => 40,
      onClose: () => {},
      onRender,
    });

    let rows = instance.render(90);
    let text = textOf(rows);
    expect(text).toContain("Show 3 more models");
    expect(text).not.toContain("provider:model-8");

    const toggleRow = rows.map(stripTerminalSequences)
      .findIndex((line) => line.includes("Show 3 more models"));
    expect(toggleRow).toBeGreaterThan(0);
    expect(instance.handleMouse({
      kind: "move",
      button: 35,
      x: 10,
      y: toggleRow,
      release: false,
      clickCount: 1,
    })).toBe(true);
    expect(instance.handleMouse({
      kind: "press",
      button: 0,
      x: 10,
      y: toggleRow,
      release: false,
      clickCount: 1,
    })).toBe(true);

    rows = instance.render(90);
    text = textOf(rows);
    expect(text).toContain("provider:model-8");
    expect(text).toContain("Show fewer models");

    instance.handleInput("m");
    expect(textOf(instance.render(90))).toContain("Show 3 more models");
    expect(onRender).toHaveBeenCalledTimes(2);
  });

  it("never emits an over-wide row in a tiny terminal", () => {
    const { instance } = panel(5);
    const lines = instance.render(7);
    expect(lines.length).toBeLessThanOrEqual(1);
    expect(lines.every((line) => visibleWidth(line) <= 7)).toBe(true);
  });
});

describe("/stats Pi TUI integration", () => {
  it("opens the overlay and restores composer focus after Esc", async () => {
    const previousHome = process.env.BUBBLE_HOME;
    const home = mkdtempSync(join(tmpdir(), "bubble-tui-stats-"));
    process.env.BUBBLE_HOME = home;
    const sessionsDir = join(home, "sessions", "project");
    mkdirSync(sessionsDir, { recursive: true });
    const timestamp = Date.now();
    writeFileSync(join(sessionsDir, "usage.jsonl"), Array.from({ length: 8 }, (_value, index) => JSON.stringify({
      type: "assistant_message",
      timestamp,
      message: {
        role: "assistant",
        content: `answer ${index + 1}`,
        model: `test-provider:m${index + 1}`,
        providerId: "test-provider",
        modelId: `m${index + 1}`,
        usage: {
          promptTokens: (8 - index) * 1_000,
          completionTokens: 100,
        },
      },
    })).join("\n") + "\n");
    const terminal = new VirtualTerminal(100, 30);
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
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
      appendDisplayMessage: () => {},
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
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
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
      terminal,
    });

    app.start();
    try {
      terminal.sendInput("/stats");
      terminal.sendInput("\x1b");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      const overlay = terminal.getViewport().join("\n");
      expect(overlay).toContain("Last 7 days");
      expect(overlay).toContain("Last 30 days");

      terminal.sendInput("G");
      await terminal.waitForRender();
      const scrolled = terminal.getViewport().join("\n");
      expect(scrolled).toContain("Show 3 more models");
      expect(scrolled).not.toContain("test-provider:m8");

      const viewport = terminal.getViewport();
      const toggleRow = viewport.findIndex((line) => line.includes("Show 3 more models"));
      const toggleColumn = viewport[toggleRow]?.indexOf("Show 3 more models") ?? -1;
      expect(toggleRow).toBeGreaterThanOrEqual(0);
      expect(toggleColumn).toBeGreaterThanOrEqual(0);
      terminal.sendInput(`\x1b[<0;${toggleColumn + 1};${toggleRow + 1}M`);
      terminal.sendInput(`\x1b[<0;${toggleColumn + 1};${toggleRow + 1}m`);
      await terminal.waitForRender();
      const expanded = terminal.getViewport().join("\n");
      expect(expanded).toContain("test-provider:m8");
      expect(expanded).toContain("Show fewer models");

      terminal.sendInput("\x1b");
      terminal.sendInput("stats-closed");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("stats-closed");
    } finally {
      app.dispose();
      if (previousHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previousHome;
    }
  });
});

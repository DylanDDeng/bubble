import chalk from "chalk";
import stringWidth from "string-width";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTuiApp } from "../tui/app.js";
import {
  formatExternalRuntimeFooterLabel,
  ResponsiveFooterComponent,
  renderFooterLine,
  renderPermissionModeBadge,
} from "../tui/footer.js";

const agent = {
  model: "kimi-for-coding:k3-长模型🤖",
  getContextUsageSnapshot: () => ({ usedTokens: 12_345, contextWindow: 128_000 }),
};

let previousChalkLevel = chalk.level;

beforeEach(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});

afterEach(() => {
  chalk.level = previousChalkLevel;
});

describe("responsive TUI footer", () => {
  it("stays on one terminal row at every narrow width with ANSI and wide cells", () => {
    for (let width = 1; width <= 40; width += 1) {
      const line = renderFooterLine(agent, width, {
        cwd: "~/项目/终端🫧",
        extra: [chalk.yellow("queue ×12"), chalk.magenta("steer ×3 🚦")],
        mode: "bypassPermissions",
      });

      expect(line).not.toContain("\n");
      expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("renders exactly one live-width row, or no row when hidden", () => {
    let hidden = false;
    const footer = new ResponsiveFooterComponent(() => ({
      agent,
      cwd: "~/项目/终端🫧",
      extra: [chalk.yellow("queue ×12")],
      hidden,
    }));

    for (let width = 1; width <= 40; width += 1) {
      const rows = footer.render(width);
      expect(rows).toHaveLength(1);
      expect(stringWidth(rows[0]!)).toBeLessThanOrEqual(width);
    }

    hidden = true;
    expect(footer.render(20)).toEqual([]);
  });

  it("renders an active goal as a separate width-safe status row", () => {
    const footer = new ResponsiveFooterComponent(() => ({
      agent,
      cwd: "~/project",
      goalLine: "goal: active · 12 turns · 63.9K/200K tok — ship the release safely",
    }));

    for (let width = 1; width <= 80; width += 1) {
      const rows = footer.render(width);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => stringWidth(row) <= width)).toBe(true);
    }
    expect(footer.render(80)[0]).toContain("goal: active");
  });

  it("shows the legacy non-default permission badges and hides default mode", () => {
    expect(renderPermissionModeBadge("default")).toBe("");
    expect(renderPermissionModeBadge("plan")).toContain("⏸ plan on");
    expect(renderPermissionModeBadge("bypassPermissions")).toContain("⏵⏵ bypass permission on");

    const plan = renderFooterLine(agent, 100, { mode: "plan" });
    const bypass = renderFooterLine(agent, 100, { mode: "bypassPermissions" });
    expect(plan).toContain("plan on");
    expect(bypass).toContain("bypass permission on");
  });

  it("keeps the model in the same muted hierarchy as cwd and context usage", () => {
    const line = renderFooterLine(agent, 100, { cwd: "~/project" });
    expect(line).toContain(chalk.dim(agent.model));
    expect(line).toContain(chalk.dim("~/project"));
    expect(line).not.toContain(chalk.cyan(agent.model));
  });

  it("adds branch and session title to the native footer hierarchy", () => {
    const line = renderFooterLine(agent, 160, {
      cwd: "~/project",
      branch: "rewrite/pi-tui",
      sessionTitle: "修复 Footer 信息",
    });

    expect(line).toContain(chalk.dim("rewrite/pi-tui"));
    expect(line).toContain(chalk.dim("修复 Footer 信息"));
  });

  it("renders external runtime state separately and hides native model, title, and context", () => {
    const runtimeLabel = formatExternalRuntimeFooterLabel({
      id: "grok",
      modelId: "grok-code-fast-1",
      reasoningEffort: "high",
    });
    const footer = new ResponsiveFooterComponent(() => ({
      agent,
      cwd: "~/project",
      branch: "main",
      sessionTitle: "native title",
      runtimeLabel,
    }));

    const rows = footer.render(160);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Grok Subscription · grok-code-fast-1 · high · workspace");
    expect(rows[1]).toContain("~/project");
    expect(rows[1]).toContain("main");
    expect(rows.join("\n")).not.toContain(agent.model);
    expect(rows.join("\n")).not.toContain("native title");
    expect(rows.join("\n")).not.toContain("12.3K/128K");
  });

  it("labels unsupported persisted runtimes as recovery-only", () => {
    expect(formatExternalRuntimeFooterLabel({ id: "future-runtime" }))
      .toBe("Unsupported external runtime · recovery-only");
  });

  it("updates branch and async session-title metadata in the mounted footer", async () => {
    const terminal = new VirtualTerminal(160, 24);
    let metadata: { title?: string } = { title: "Initial session title" };
    const metadataListeners = new Set<() => void>();
    const sessionManager = {
      getSessionFile: () => "/tmp/footer-session.jsonl",
      getMetadata: () => metadata,
      subscribeMetadata: (listener: () => void) => {
        metadataListeners.add(listener);
        return () => metadataListeners.delete(listener);
      },
    };
    const controller = {
      subscribe: () => () => {},
      getSessionManager: () => sessionManager,
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
        model: "test:model",
        providerId: "test",
        thinking: "medium",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 12_345, contextWindow: 128_000 }),
      } as never,
      sessionManager: sessionManager as never,
      controller: controller as never,
      callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
      terminal,
      resolveGitBranch: async () => "feature/footer-parity",
    });

    app.start();
    try {
      await vi.waitFor(() => {
        const viewport = terminal.getViewport().join("\n");
        expect(viewport).toContain("feature/footer-parity");
        expect(viewport).toContain("Initial session title");
      });

      metadata = { title: "Generated title arrived" };
      for (const listener of metadataListeners) listener();

      await vi.waitFor(() => {
        const viewport = terminal.getViewport().join("\n");
        expect(viewport).toContain("Generated title arrived");
        expect(viewport).not.toContain("Initial session title");
      });
    } finally {
      app.dispose();
    }
  });
});

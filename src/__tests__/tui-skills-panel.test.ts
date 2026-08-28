import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@bubblebrain-ai/pi-tui";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { SkillRegistry } from "../skills/registry.js";
import { SkillsPanelComponent } from "../tui/components/skills-panel.js";
import { PiTuiApp } from "../tui/app.js";

function fixture() {
  const root = join(tmpdir(), `bubble-skills-panel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cwd = join(root, "project");
  const projectSkill = join(cwd, ".bubble", "skills", "repo-review");
  const userSkill = join(root, "home", "skills", "podcast");
  mkdirSync(projectSkill, { recursive: true });
  mkdirSync(userSkill, { recursive: true });
  writeFileSync(join(projectSkill, "SKILL.md"), `---
description: Review repository architecture and risks.
author: Bubble Team
allowed-tools:
  - read
  - grep
tags:
  - review
---

Review it.
`);
  writeFileSync(join(userSkill, "SKILL.md"), `---
description: Produce a Chinese podcast.
---

Write it.
`);
  const registry = new SkillRegistry({
    cwd,
    bubbleHome: join(root, "home"),
    agentsHome: join(root, "agents"),
    claudeHome: join(root, "claude"),
  });
  const onRender = vi.fn();
  const onSkillsChanged = vi.fn();
  const panel = new SkillsPanelComponent(registry, {
    getTerminalRows: () => 40,
    onClose: vi.fn(),
    onRender,
    onSkillsChanged,
  });
  panel.focused = true;
  return { root, cwd, registry, panel, onRender, onSkillsChanged };
}

function plain(lines: string[]): string {
  return lines.map(stripTerminalSequences).join("\n");
}

describe("SkillsPanelComponent", () => {
  it("routes /skills to the dedicated centered overlay", async () => {
    const { registry } = fixture();
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
        model: "test:model",
        providerId: "test",
        thinking: "off",
        mode: "default",
        setMode: () => {},
        setSkillSummaries: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: { getSessionFile: () => "/session.jsonl" } as never,
      controller: controller as never,
      skillRegistry: registry,
      callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
      terminal,
    });
    app.start();
    try {
      await (app as unknown as { handleCommand(command: string): Promise<void> }).handleCommand("/skills");
      await terminal.waitForRender();
      const screen = terminal.getViewport().join("\n");
      expect(screen).toContain("Skills");
      expect(screen).toContain("Project (1 skill)");
      expect((app as unknown as { tui: { hasOverlay(): boolean } }).tui.hasOverlay()).toBe(true);

      terminal.resize(30, 10);
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Skills requires");
      terminal.sendInput("\x1b");
      await terminal.waitForRender();
      expect((app as unknown as { tui: { hasOverlay(): boolean } }).tui.hasOverlay()).toBe(false);
    } finally {
      app.dispose();
    }
  });

  it("renders Grok-style collapsed source groups and expandable Skill details", () => {
    const { panel } = fixture();
    let lines = panel.render(110);
    expect(plain(lines)).toContain("Project (1 skill)");
    expect(plain(lines)).toContain("User (1 skill)");
    expect(plain(lines)).not.toContain("repo-review");

    panel.handleInput("\r");
    lines = panel.render(110);
    expect(plain(lines)).toContain("repo-review");

    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    lines = panel.render(110);
    expect(plain(lines)).toContain("Review repository architecture and risks.");
    expect(plain(lines)).toContain("author: Bubble Team");
    expect(plain(lines)).toContain("tools: read, grep");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(110);
  });

  it("searches across collapsed groups and toggles the selected Skill", () => {
    const { panel, registry, onSkillsChanged } = fixture();
    panel.render(100);
    panel.handleInput("/");
    panel.handleInput("podcast");
    let lines = panel.render(100);
    expect(plain(lines)).toContain("podcast");
    expect(plain(lines)).not.toContain("repo-review");

    panel.handleInput("\x1b");
    panel.render(100);
    panel.handleInput("\r");
    panel.render(100);
    panel.handleInput("\x1b[B");
    panel.handleInput(" ");
    lines = panel.render(100);
    expect(plain(lines)).toContain("[disabled]");
    expect(registry.get("repo-review")).toBeUndefined();
    expect(registry.getAny("repo-review")).toBeDefined();
    expect(onSkillsChanged).toHaveBeenCalled();

    panel.handleInput("f");
    expect(plain(panel.render(100))).not.toContain("repo-review");
    panel.handleInput("f");
    expect(plain(panel.render(100))).toContain("repo-review");
  });

  it("fills the complete hovered row with the shared trace hover color", () => {
    const { panel } = fixture();
    panel.render(100);
    panel.handleInput("\r");
    const expanded = panel.render(100);
    const skillRow = expanded.findIndex((line) => stripTerminalSequences(line).includes("repo-review"));
    expect(skillRow).toBeGreaterThan(0);
    expect(panel.handleMouse({ kind: "move", button: 35, x: 20, y: skillRow, release: false, clickCount: 1 })).toBe(true);
    const hovered = panel.render(100)[skillRow] ?? "";
    expect(stripTerminalSequences(hovered)).toContain("repo-review");
  });

  it("reloads newly installed Skills without reopening the panel", () => {
    const { cwd, registry, panel, onSkillsChanged } = fixture();
    panel.render(100);
    const added = join(cwd, ".bubble", "skills", "new-skill");
    mkdirSync(added, { recursive: true });
    writeFileSync(join(added, "SKILL.md"), "---\ndescription: Added live.\n---\n\nUse it.\n");

    panel.handleInput("r");
    panel.render(100);
    expect(registry.getAny("new-skill")).toBeDefined();
    expect(onSkillsChanged).toHaveBeenCalled();
  });
});

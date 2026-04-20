import { describe, expect, it, vi } from "vitest";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    agent: {
      model: "openai:gpt-4o",
      providerId: "openai",
      thinking: "off",
      setSystemPrompt: vi.fn(),
      setProvider: vi.fn(),
    } as any,
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    cwd: "/tmp",
    exit: vi.fn(),
    createProvider: vi.fn() as any,
    openPicker: vi.fn(),
    registry: {
      getEnabled: () => [],
    } as any,
    skillRegistry: new SkillRegistry({ cwd: "/tmp" }),
    ...overrides,
  };
}

function createSkillRegistryFixture(): SkillRegistry {
  const root = join(tmpdir(), `bubble-skill-slash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".bubble", "skills", "repo-review"), { recursive: true });
  writeFileSync(
    join(cwd, ".bubble", "skills", "repo-review", "SKILL.md"),
    `---
description: Review a codebase for architecture and risks.
tags:
  - review
---

Read the repo carefully before proposing changes.
`,
  );
  return new SkillRegistry({ cwd, bubbleHome: join(root, "home") });
}

describe("slash commands", () => {
  it("returns guidance instead of opening an empty model picker when no provider is configured", async () => {
    const ctx = createContext();
    const result = await slashRegistry.execute("/model", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBe("No provider configured. Use /login or /provider --add <id> first.");
    expect(ctx.openPicker).not.toHaveBeenCalled();
  });

  it("lists available skills", async () => {
    const ctx = createContext({
      skillRegistry: createSkillRegistryFixture(),
    });

    const result = await slashRegistry.execute("/skills", ctx);
    expect(result.handled).toBe(true);
    expect(result.result).toContain("Available skills:");
    expect(result.result).toContain("repo-review");
  });

  it("loads a skill explicitly via /skill", async () => {
    const appendMarker = vi.fn();
    const ctx = createContext({
      skillRegistry: createSkillRegistryFixture(),
      sessionManager: {
        appendMarker,
      } as any,
    });

    const result = await slashRegistry.execute("/skill repo-review", ctx);
    expect(result.handled).toBe(true);
    expect(result.result).toContain("Skill: repo-review");
    expect(appendMarker).toHaveBeenCalledWith("skill_activated", "repo-review");
  });

  it("/plan toggles the agent mode and delegates to setMode", async () => {
    let mode = "default";
    const ctx = createContext({
      agent: {
        model: "openai:gpt-4o",
        providerId: "openai",
        thinking: "off",
        get mode() {
          return mode;
        },
        setMode: (next: string) => {
          mode = next;
        },
      } as any,
    });

    let result = await slashRegistry.execute("/plan", ctx);
    expect(result.handled).toBe(true);
    expect(mode).toBe("plan");
    expect(result.result).toContain("Entered plan mode");

    result = await slashRegistry.execute("/plan", ctx);
    expect(mode).toBe("default");
    expect(result.result).toContain("Exited plan mode");
  });

  it("/todos lists items; /todos clear empties the list", async () => {
    let todos = [
      { content: "a", activeForm: "doing a", status: "in_progress" },
      { content: "b", activeForm: "doing b", status: "pending" },
    ];
    const ctx = createContext({
      agent: {
        model: "openai:gpt-4o",
        providerId: "openai",
        thinking: "off",
        getTodos: () => todos,
        setTodos: (next: any[]) => {
          todos = next;
        },
      } as any,
    });

    let result = await slashRegistry.execute("/todos", ctx);
    expect(result.result).toContain("Todos:");
    expect(result.result).toContain("doing a");
    expect(result.result).toContain("b");

    result = await slashRegistry.execute("/todos clear", ctx);
    expect(result.result).toContain("Cleared 2");
    expect(todos).toEqual([]);

    result = await slashRegistry.execute("/todos clear", ctx);
    expect(result.result).toContain("already empty");
  });

  it("/permissions lists the bash allowlist and /permissions clear empties it", async () => {
    const { BashAllowlist } = await import("../approval/session-cache.js");
    const allowlist = new BashAllowlist();
    allowlist.add("git status");
    allowlist.add("npm test");

    const ctx = createContext({
      bashAllowlist: allowlist,
    } as any);

    let result = await slashRegistry.execute("/permissions", ctx);
    expect(result.handled).toBe(true);
    expect(result.result).toContain("Session bash allowlist");
    expect(result.result).toContain("git status");
    expect(result.result).toContain("npm test");

    result = await slashRegistry.execute("/permissions clear", ctx);
    expect(result.result).toContain("Cleared 2");
    expect(allowlist.size()).toBe(0);

    result = await slashRegistry.execute("/permissions clear", ctx);
    expect(result.result).toContain("already empty");
  });

  it("/permissions add writes a rule and makes it visible to getMerged", async () => {
    const { SettingsManager } = await import("../permissions/settings.js");
    const root = join(tmpdir(), `bubble-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const bubbleHome = join(root, "home");
    const cwd = join(root, "project");
    mkdirSync(bubbleHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const settingsManager = new SettingsManager(cwd, { bubbleHome });

    const ctx = createContext({ settingsManager } as any);

    const added = await slashRegistry.execute("/permissions add local allow Bash(git status)", ctx);
    expect(added.handled).toBe(true);
    expect(added.result).toContain("Added to local allow");

    const merged = settingsManager.getMerged();
    expect(merged.ruleSet.allow.map((r) => r.source)).toContain("Bash(git status)");
  });

  it("/permissions add rejects invalid rules", async () => {
    const { SettingsManager } = await import("../permissions/settings.js");
    const root = join(tmpdir(), `bubble-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const settingsManager = new SettingsManager(join(root, "project"), { bubbleHome: join(root, "home") });

    const ctx = createContext({ settingsManager } as any);

    const result = await slashRegistry.execute("/permissions add user allow Bash()", ctx);
    expect(result.result).toContain("Invalid rule");
  });

  it("/permissions add rejects unknown scope or list", async () => {
    const { SettingsManager } = await import("../permissions/settings.js");
    const root = join(tmpdir(), `bubble-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const settingsManager = new SettingsManager(join(root, "project"), { bubbleHome: join(root, "home") });

    const ctx = createContext({ settingsManager } as any);

    expect((await slashRegistry.execute("/permissions add global allow Bash(ls)", ctx)).result)
      .toContain("Unknown scope");
    expect((await slashRegistry.execute("/permissions add user maybe Bash(ls)", ctx)).result)
      .toContain("Unknown list");
  });

  it("/permissions remove deletes an existing rule", async () => {
    const { SettingsManager } = await import("../permissions/settings.js");
    const root = join(tmpdir(), `bubble-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const settingsManager = new SettingsManager(join(root, "project"), { bubbleHome: join(root, "home") });
    settingsManager.addRule("local", "deny", "Bash(rm -rf:*)");

    const ctx = createContext({ settingsManager } as any);

    const result = await slashRegistry.execute("/permissions remove local deny Bash(rm -rf:*)", ctx);
    expect(result.result).toContain("Removed from local deny");
    expect(settingsManager.getMerged().ruleSet.deny).toHaveLength(0);
  });

  it("/permissions remove reports when the rule is missing", async () => {
    const { SettingsManager } = await import("../permissions/settings.js");
    const root = join(tmpdir(), `bubble-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const settingsManager = new SettingsManager(join(root, "project"), { bubbleHome: join(root, "home") });

    const ctx = createContext({ settingsManager } as any);

    const result = await slashRegistry.execute("/permissions remove local allow Bash(ls)", ctx);
    expect(result.result).toContain("Rule not found");
  });

  it("/permissions add reports duplicates without writing twice", async () => {
    const { SettingsManager } = await import("../permissions/settings.js");
    const root = join(tmpdir(), `bubble-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const settingsManager = new SettingsManager(join(root, "project"), { bubbleHome: join(root, "home") });

    const ctx = createContext({ settingsManager } as any);

    await slashRegistry.execute("/permissions add user allow Bash(ls)", ctx);
    const dup = await slashRegistry.execute("/permissions add user allow Bash(ls)", ctx);
    expect(dup.result).toContain("already present");
    expect(settingsManager.getMerged().ruleSet.allow).toHaveLength(1);
  });

  it("/permissions add without args shows usage", async () => {
    const { SettingsManager } = await import("../permissions/settings.js");
    const root = join(tmpdir(), `bubble-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const settingsManager = new SettingsManager(join(root, "project"), { bubbleHome: join(root, "home") });

    const ctx = createContext({ settingsManager } as any);

    const result = await slashRegistry.execute("/permissions add", ctx);
    expect(result.result).toContain("Usage:");
  });

  it("loads a skill directly via /<skill-name> alias", async () => {
    const ctx = createContext({
      skillRegistry: createSkillRegistryFixture(),
    });

    const result = await slashRegistry.execute("/repo-review", ctx);
    expect(result.handled).toBe(true);
    expect(result.result).toContain('Use /repo-review <your request> to run with this skill');
  });
});

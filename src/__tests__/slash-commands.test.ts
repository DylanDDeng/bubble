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

  it("loads a skill directly via /<skill-name> alias", async () => {
    const ctx = createContext({
      skillRegistry: createSkillRegistryFixture(),
    });

    const result = await slashRegistry.execute("/repo-review", ctx);
    expect(result.handled).toBe(true);
    expect(result.result).toContain('Use /repo-review <your request> to run with this skill');
  });
});

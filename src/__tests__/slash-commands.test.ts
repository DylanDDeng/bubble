import { describe, expect, it, vi } from "vitest";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    skillRegistry: new SkillRegistry({
      cwd: "/tmp",
      bubbleHome: join(tmpdir(), `bubble-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      agentsHome: join(tmpdir(), `agents-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      claudeHome: join(tmpdir(), `claude-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    }),
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
  return new SkillRegistry({
    cwd,
    bubbleHome: join(root, "home"),
    agentsHome: join(root, "agents"),
    claudeHome: join(root, "claude"),
  });
}

describe("slash commands", () => {
  it("opens the model dialog when no provider is configured so provider fallback can be shown", async () => {
    const ctx = createContext();
    const result = await slashRegistry.execute("/model", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(ctx.openPicker).toHaveBeenCalledWith("model");
  });

  it("opens the feedback dialog with the provided description", async () => {
    const openFeedback = vi.fn();
    const ctx = createContext({ openFeedback });
    const result = await slashRegistry.execute("/feedback cursor jumps after submit", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(openFeedback).toHaveBeenCalledWith("cursor jumps after submit");
  });

  it("opens the stats panel from /stats", async () => {
    const openStats = vi.fn();
    const ctx = createContext({ openStats });
    const result = await slashRegistry.execute("/stats", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(openStats).toHaveBeenCalledTimes(1);
  });

  it("/quit only requests TUI exit and does not force process.exit", async () => {
    vi.useFakeTimers();
    const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never));
    const shutdown = vi.fn();
    const flushMemory = vi.fn();
    const ctx = createContext({
      mcpManager: { shutdown } as any,
      flushMemory,
    });

    try {
      const result = await slashRegistry.execute("/quit", ctx);
      vi.runAllTimers();

      expect(result.handled).toBe(true);
      expect(ctx.exit).toHaveBeenCalledTimes(1);
      expect(shutdown).not.toHaveBeenCalled();
      expect(flushMemory).not.toHaveBeenCalled();
      expect(processExit).not.toHaveBeenCalled();
    } finally {
      processExit.mockRestore();
      vi.useRealTimers();
    }
  });

  it("/key can update an explicitly targeted provider before it is enabled", async () => {
    const updateProviderKey = vi.fn();
    const setDefault = vi.fn();
    const createProvider = vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() })) as any;
    const setProvider = vi.fn();
    const ctx = createContext({
      agent: {
        model: "zhipuai-coding-plan:glm-5.1",
        providerId: "zhipuai-coding-plan",
        thinking: "off",
        setSystemPrompt: vi.fn(),
        setProvider,
      } as any,
      createProvider,
      registry: {
        getDefault: () => ({
          id: "zhipuai-coding-plan",
          name: "Zhipu AI Coding Plan",
          baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
          apiKey: "zhipu-key",
          enabled: true,
        }),
        getConfigured: () => [
          {
            id: "zhipuai-coding-plan",
            name: "Zhipu AI Coding Plan",
            baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
            apiKey: "zhipu-key",
            enabled: true,
          },
          {
            id: "deepseek",
            name: "DeepSeek",
            baseURL: "https://api.deepseek.com",
            apiKey: "",
            enabled: true,
          },
        ],
        getModelConfig: () => ({ hasProvider: () => false }),
        updateProviderKey,
        setDefault,
      } as any,
    });

    const result = await slashRegistry.execute("/key deepseek sk-deepseek", ctx);

    expect(result.handled).toBe(true);
    expect(updateProviderKey).toHaveBeenCalledWith("deepseek", "sk-deepseek");
    expect(setDefault).toHaveBeenCalledWith("deepseek");
    expect(createProvider).toHaveBeenCalledWith("deepseek", "sk-deepseek", "https://api.deepseek.com");
    expect(ctx.agent.providerId).toBe("deepseek");
    expect(result.result).toContain("API key updated for DeepSeek");
  });

  it("/model preserves provider keys already written to config", async () => {
    const originalBubbleHome = process.env.BUBBLE_HOME;
    const root = join(tmpdir(), `bubble-model-persist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(root, { recursive: true });
    process.env.BUBBLE_HOME = root;
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
        providers: [
          {
            id: "deepseek",
            name: "DeepSeek",
            baseURL: "https://api.deepseek.com",
            apiKey: "sk-preserve",
            enabled: true,
          },
        ],
        defaultProvider: "deepseek",
      }, null, 2),
    );

    try {
      const ctx = createContext({
        agent: {
          model: "",
          providerId: "deepseek",
          thinking: "off",
          setSystemPrompt: vi.fn(),
          setProvider: vi.fn(),
        } as any,
        createProvider: vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() })) as any,
        registry: {
          getDefault: () => ({
            id: "deepseek",
            name: "DeepSeek",
            baseURL: "https://api.deepseek.com",
            apiKey: "sk-preserve",
            enabled: true,
          }),
          getConfigured: () => [
            {
              id: "deepseek",
              name: "DeepSeek",
              baseURL: "https://api.deepseek.com",
              apiKey: "sk-preserve",
              enabled: true,
            },
          ],
          getModelConfig: () => ({ hasProvider: () => false }),
          prepareProvider: vi.fn(),
        } as any,
      });

      await slashRegistry.execute("/model deepseek:deepseek-v4-pro --reasoning-effort max", ctx);

      const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
      expect(saved.providers[0].apiKey).toBe("sk-preserve");
      expect(saved.defaultModel).toBe("deepseek:deepseek-v4-pro");
      expect(saved.defaultThinkingLevel).toBe("max");
    } finally {
      if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = originalBubbleHome;
    }
  });

  it("opens the skill picker from /skills", async () => {
    const ctx = createContext({
      skillRegistry: createSkillRegistryFixture(),
    });

    const result = await slashRegistry.execute("/skills", ctx);
    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(ctx.openPicker).toHaveBeenCalledWith("skill");
  });

  it("/context shows usage breakdown", async () => {
    const ctx = createContext({
      agent: {
        model: "openai:gpt-4o",
        providerId: "openai",
        thinking: "off",
        setSystemPrompt: vi.fn(),
        setProvider: vi.fn(),
        getContextUsageSnapshot: () => ({
          providerId: "openai",
          modelId: "gpt-4o",
          contextWindow: 128000,
          usedTokens: 3000,
          freeTokens: 125000,
          buckets: {
            systemPrompt: { label: "System prompt", tokens: 1000, detail: "1 system message" },
            tools: { label: "Tools", tokens: 800, detail: "2 active tools" },
            skills: { label: "Skills", tokens: 700, detail: "3 advertised skills" },
            deferredTools: { label: "Deferred/MCP", tokens: 200, detail: "1 deferred tool name in reminder" },
            other: { label: "Other", tokens: 500, detail: "2 conversation/meta/tool messages" },
          },
          toolCount: 2,
          deferredToolCount: 1,
          skillCount: 3,
          messageCount: 3,
        }),
      } as any,
    });

    const result = await slashRegistry.execute("/context", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toContain("Free space:");
    expect(result.result).toContain("System prompt");
    expect(result.result).toContain("Tools");
    expect(result.result).toContain("Skills");
    expect(result.result).toContain("Deferred/MCP");
    expect(result.result).toContain("Other");
  });

  it("/memory disables manual add and searches automatic memory workspace", async () => {
    const originalBubbleHome = process.env.BUBBLE_HOME;
    const root = join(tmpdir(), `bubble-memory-slash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const cwd = join(root, "project");
    const home = join(root, "home");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(home, { recursive: true });
    process.env.BUBBLE_HOME = home;

    try {
      const ctx = createContext({ cwd });
      let result = await slashRegistry.execute("/memory add prefer targeted memory tests", ctx);
      expect(result.handled).toBe(true);
      expect(result.result).toContain("Manual memory writes are disabled");

      const { getMemoryPaths } = await import("../memory/index.js");
      const paths = getMemoryPaths(cwd);
      mkdirSync(paths.globalRoot, { recursive: true });
      writeFileSync(paths.globalMemory, "# Bubble Memory\n\nprefer targeted memory tests\n", "utf-8");

      result = await slashRegistry.execute("/memory status", ctx);
      expect(result.result).toContain("environment: custom");
      expect(result.result).toContain(`bubble home: ${home}`);

      result = await slashRegistry.execute("/memory search targeted", ctx);
      expect(result.result).toContain("Memory search results");
      expect(result.result).toContain("prefer targeted memory tests");
      expect(result.result).toContain(join(home, "memories", "MEMORY.md"));
    } finally {
      if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = originalBubbleHome;
    }
  });

  it("/memory compact delegates to startup memory pipeline", async () => {
    const runMemoryCompaction = vi.fn(async () => "Memory startup succeeded.");
    const ctx = createContext({ runMemoryCompaction });

    const result = await slashRegistry.execute("/memory compact", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toContain("Memory startup");
    expect(runMemoryCompaction).toHaveBeenCalledTimes(1);
  });

  it("/compact rebuilds agent history without clearing the TUI first", async () => {
    const clearMessages = vi.fn();
    const resetContextUsageAnchor = vi.fn();
    const ctx = createContext({
      clearMessages,
      agent: {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "old prompt" },
        ],
        resetContextUsageAnchor,
      } as any,
      sessionManager: {
        compact: vi.fn(() => ({ compacted: true, droppedEntries: 2 })),
        getMessages: vi.fn(() => [
          { role: "system", content: "Previous conversation summary:\nold prompt" },
          { role: "user", content: "recent prompt" },
          { role: "assistant", content: "recent answer" },
        ]),
      } as any,
    });

    const result = await slashRegistry.execute("/compact", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toContain("Compaction complete");
    expect(clearMessages).not.toHaveBeenCalled();
    expect(ctx.agent.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "system", content: "Previous conversation summary:\nold prompt" },
      { role: "user", content: "recent prompt" },
      { role: "assistant", content: "recent answer" },
    ]);
    expect(resetContextUsageAnchor).toHaveBeenCalledTimes(1);
  });

  it("/memory summarize and refresh delegate to Codex-style memory handlers", async () => {
    const runMemorySummary = vi.fn(async () => "Memory Phase 2 succeeded: selected 1.");
    const runMemoryRefresh = vi.fn(async () => "Memory startup succeeded.");
    const ctx = createContext({ runMemorySummary, runMemoryRefresh });

    let result = await slashRegistry.execute("/memory summarize --global", ctx);
    expect(result.handled).toBe(true);
    expect(result.result).toContain("Phase 2");
    expect(runMemorySummary).toHaveBeenCalledWith("global");

    result = await slashRegistry.execute("/memory refresh --project", ctx);
    expect(result.result).toContain("Memory startup");
    expect(runMemoryRefresh).toHaveBeenCalledWith("project");
  });

  it("/memory reset clears automatic memory artifacts", async () => {
    const originalBubbleHome = process.env.BUBBLE_HOME;
    const root = join(tmpdir(), `bubble-memory-review-slash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const cwd = join(root, "project");
    const home = join(root, "home");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    process.env.BUBBLE_HOME = home;

    try {
      const { getMemoryPaths, MemoryDatabase } = await import("../memory/index.js");
      const paths = getMemoryPaths(cwd);
      mkdirSync(paths.globalRoot, { recursive: true });
      writeFileSync(paths.globalMemory, "# Bubble Memory\n\nreset me\n", "utf-8");
      const db = new MemoryDatabase(cwd);
      db.upsertStage1Output({
        sessionFile: "session.jsonl",
        cwd,
        entryCount: 4,
        sourceUpdatedAt: "2026-04-29T00:00:00.000Z",
        generatedAt: "2026-04-29T00:00:00.000Z",
        rawMemory: "reset me",
        rolloutSummary: "reset me",
      });
      db.close();

      const ctx = createContext({ cwd });
      const result = await slashRegistry.execute("/memory reset", ctx);
      expect(result.result).toContain("Memory reset complete");
      expect(existsSync(paths.globalMemory)).toBe(false);
      expect(existsSync(paths.globalDatabase)).toBe(false);
    } finally {
      if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = originalBubbleHome;
    }
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

  it("/sidebar toggles the TUI sidebar", async () => {
    const toggleSidebar = vi.fn(() => ({
      mode: "collapsed" as const,
      visible: false,
      active: true,
    }));
    const setSidebarMode = vi.fn();
    const ctx = createContext({ toggleSidebar, setSidebarMode });

    const result = await slashRegistry.execute("/sidebar", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    expect(setSidebarMode).not.toHaveBeenCalled();
  });

  it("/sidebar accepts explicit open, close, and auto modes", async () => {
    const toggleSidebar = vi.fn();
    const setSidebarMode = vi.fn((mode) => ({
      mode,
      visible: mode !== "collapsed",
      active: true,
    }));
    const ctx = createContext({ toggleSidebar, setSidebarMode });

    expect((await slashRegistry.execute("/sidebar open", ctx)).result).toBeUndefined();
    expect((await slashRegistry.execute("/sidebar close", ctx)).result).toBeUndefined();
    expect((await slashRegistry.execute("/sidebar auto", ctx)).result).toBeUndefined();
    expect(setSidebarMode).toHaveBeenNthCalledWith(1, "expanded");
    expect(setSidebarMode).toHaveBeenNthCalledWith(2, "collapsed");
    expect(setSidebarMode).toHaveBeenNthCalledWith(3, "auto");
    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it("/clear resets agent context, todos, display history, and records a session boundary", async () => {
    let todos = [
      { content: "a", activeForm: "doing a", status: "in_progress" },
    ];
    const appendMarker = vi.fn();
    const clearMessages = vi.fn();
    const ctx = createContext({
      clearMessages,
      agent: {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "meta", kind: "system-reminder", content: "tool reminder" },
          { role: "user", content: "old prompt" },
          { role: "assistant", content: "old answer" },
        ],
        getTodos: () => todos,
        setTodos: (next: any[]) => {
          todos = next;
        },
      } as any,
      sessionManager: {
        appendMarker,
      } as any,
    });

    const result = await slashRegistry.execute("/clear", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(ctx.agent.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "meta", kind: "system-reminder", content: "tool reminder" },
    ]);
    expect(todos).toEqual([]);
    expect(appendMarker).toHaveBeenCalledWith("conversation_clear", "");
    expect(clearMessages).toHaveBeenCalledTimes(1);
  });

  it("/clear clears agent context before touching the TUI", async () => {
    const appendMarker = vi.fn();
    const ctx = createContext({
      clearMessages: vi.fn(() => {
        throw new Error("render failed");
      }),
      agent: {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "old prompt" },
        ],
        getTodos: () => [],
        setTodos: vi.fn(),
      } as any,
      sessionManager: {
        appendMarker,
      } as any,
    });

    const result = await slashRegistry.execute("/clear", ctx);

    expect(result.result).toContain("render failed");
    expect(ctx.agent.messages).toEqual([
      { role: "system", content: "system prompt" },
    ]);
    expect(appendMarker).toHaveBeenCalledWith("conversation_clear", "");
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

  it("/lsp reports server status", async () => {
    const ctx = createContext({
      lspService: {
        isDisabled: () => false,
        status: () => [{ id: "typescript", name: "typescript", root: ".", status: "connected" }],
        diagnostics: () => ({}),
        restart: vi.fn(),
        updateConfig: vi.fn(),
      } as any,
    });

    const result = await slashRegistry.execute("/lsp", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toContain("LSP servers:");
    expect(result.result).toContain("typescript .");
  });

  it("/lsp diagnostics formats current diagnostics", async () => {
    const ctx = createContext({
      cwd: "/tmp/project",
      lspService: {
        isDisabled: () => false,
        status: () => [],
        diagnostics: () => ({
          "/tmp/project/src/a.ts": [{
            message: "Type mismatch",
            severity: 1,
            source: "typescript",
            range: { start: { line: 1, character: 2 } },
          }],
        }),
        restart: vi.fn(),
        updateConfig: vi.fn(),
      } as any,
    });

    const result = await slashRegistry.execute("/lsp diagnostics", ctx);

    expect(result.result).toContain("LSP diagnostics:");
    expect(result.result).toContain("src/a.ts:2:3 error");
    expect(result.result).toContain("Type mismatch");
  });

  it("/lsp restart reloads settings and restarts the service", async () => {
    const reload = vi.fn();
    const updateConfig = vi.fn();
    const restart = vi.fn();
    const ctx = createContext({
      settingsManager: {
        reload,
        getMerged: () => ({ lsp: false }),
      } as any,
      lspService: {
        isDisabled: () => false,
        status: () => [],
        diagnostics: () => ({}),
        restart,
        updateConfig,
      } as any,
    });

    const result = await slashRegistry.execute("/lsp restart", ctx);

    expect(result.result).toContain("Restarted LSP");
    expect(reload).toHaveBeenCalled();
    expect(updateConfig).toHaveBeenCalledWith(false);
    expect(restart).toHaveBeenCalled();
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

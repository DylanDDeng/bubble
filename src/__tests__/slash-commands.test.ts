import { describe, expect, it, vi } from "vitest";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { loginOpenAICodex } from "../oauth/openai-codex.js";
import { importGrokCliCredentials, loginGrok } from "../oauth/grok.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../oauth/openai-codex.js", () => ({
  loginOpenAICodex: vi.fn(async () => ({
    accessToken: "oauth-access",
    refreshToken: "oauth-refresh",
    expiresAt: Date.now() + 60_000,
    accountId: "test-account",
  })),
}));

vi.mock("../oauth/grok.js", () => ({
  loginGrok: vi.fn(async () => ({
    accessToken: "grok-access",
    refreshToken: "grok-refresh",
    expiresAt: Date.now() + 60_000,
  })),
  importGrokCliCredentials: vi.fn(() => undefined),
}));

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

function createSessionStub(initialMetadata: Record<string, unknown> = {}) {
  let metadata = { ...initialMetadata };
  const updateMetadata = vi.fn((patch: Record<string, unknown>) => {
    metadata = { ...metadata, ...patch };
  });
  const clearExternalRuntimeMetadata = vi.fn(() => {
    const { externalRuntime: _externalRuntime, ...rest } = metadata;
    metadata = rest;
  });
  return {
    getMetadata: vi.fn(() => metadata),
    updateMetadata,
    clearExternalRuntimeMetadata,
    appendMarker: vi.fn(),
  } as any;
}

function createGrokAuthStorageStub(initialHas = false) {
  let stored = initialHas;
  return {
    has: vi.fn(() => stored),
    set: vi.fn(() => { stored = true; }),
    remove: vi.fn(() => { stored = false; }),
    getPath: vi.fn(() => "/tmp/auth.json"),
  };
}

function createGrokRegistryStub(authStorage: ReturnType<typeof createGrokAuthStorageStub>, overrides: Record<string, unknown> = {}) {
  return {
    getEnabled: () => [],
    getAuthStorage: () => authStorage,
    prepareProvider: vi.fn(async () => undefined),
    setDefault: vi.fn(),
    getDefaultModel: vi.fn(() => "grok-4.5"),
    getConfigured: () => [{
      id: "grok",
      name: "Grok Subscription",
      enabled: true,
      authType: "oauth",
      apiKey: "grok-access",
      baseURL: "https://cli-chat-proxy.grok.com/v1",
    }],
    ...overrides,
  } as any;
}

describe("slash commands", () => {
  it("/goal is registered and delegates the complete command to the interactive host", async () => {
    const handleGoalCommand = vi.fn();
    const ctx = createContext({ handleGoalCommand });

    const result = await slashRegistry.execute("/goal ship the release --budget 200k", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(handleGoalCommand).toHaveBeenCalledWith("/goal ship the release --budget 200k");
    expect(slashRegistry.list().some((command) => command.name === "goal")).toBe(true);
  });

  it("/login grok runs browser OAuth, stores tokens, and switches to a grok model natively", async () => {
    vi.mocked(loginGrok).mockClear();
    vi.mocked(importGrokCliCredentials).mockClear();
    const authStorage = createGrokAuthStorageStub();
    const registry = createGrokRegistryStub(authStorage);
    const createProvider = vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() } as any));
    const ctx = createContext({ registry, createProvider });

    const result = await slashRegistry.execute("/login grok", ctx);

    expect(result.result).toContain("Grok subscription login successful");
    expect(vi.mocked(loginGrok)).toHaveBeenCalledTimes(1);
    expect(authStorage.set).toHaveBeenCalledWith("grok", expect.objectContaining({
      type: "oauth",
      accessToken: "grok-access",
      refreshToken: "grok-refresh",
    }));
    expect(registry.prepareProvider).toHaveBeenCalledWith("grok");
    expect(registry.setDefault).toHaveBeenCalledWith("grok");
    expect(ctx.agent.model).toBe("grok:grok-4.5");
    expect(ctx.agent.setProvider).toHaveBeenCalledTimes(1);
  });

  it("/login grok reuses an existing Grok CLI sign-in without opening a browser", async () => {
    vi.mocked(loginGrok).mockClear();
    vi.mocked(importGrokCliCredentials).mockClear().mockReturnValueOnce({
      accessToken: "cli-access",
      refreshToken: "cli-refresh",
      expiresAt: Date.now() + 60_000,
    });
    const authStorage = createGrokAuthStorageStub();
    const registry = createGrokRegistryStub(authStorage);
    const ctx = createContext({
      registry,
      createProvider: vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() } as any)),
    });

    const result = await slashRegistry.execute("/login grok", ctx);

    expect(result.result).toContain("reused your Grok CLI sign-in");
    expect(vi.mocked(loginGrok)).not.toHaveBeenCalled();
    expect(authStorage.set).toHaveBeenCalledWith("grok", expect.objectContaining({
      accessToken: "cli-access",
      refreshToken: "cli-refresh",
    }));
  });

  it("/provider --set grok routes to the native subscription login", async () => {
    vi.mocked(loginGrok).mockClear();
    vi.mocked(importGrokCliCredentials).mockClear();
    const authStorage = createGrokAuthStorageStub(true);
    const registry = createGrokRegistryStub(authStorage);
    const ctx = createContext({
      registry,
      createProvider: vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() } as any)),
    });

    const result = await slashRegistry.execute("/provider --set grok-subscription", ctx);

    expect(result.result).toContain("Grok subscription login successful");
    // Stored credentials satisfy the login; no browser round-trip.
    expect(vi.mocked(loginGrok)).not.toHaveBeenCalled();
    expect(registry.setDefault).toHaveBeenCalledWith("grok");
  });

  it("repairs stored Grok credentials with one browser retry when refresh fails", async () => {
    vi.mocked(loginGrok).mockClear();
    vi.mocked(importGrokCliCredentials).mockClear();
    const authStorage = createGrokAuthStorageStub(true);
    const prepareProvider = vi.fn()
      .mockRejectedValueOnce(new Error("Token refresh failed: 400"))
      .mockResolvedValueOnce(undefined);
    const registry = createGrokRegistryStub(authStorage, { prepareProvider });
    const ctx = createContext({
      registry,
      createProvider: vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() } as any)),
    });

    const result = await slashRegistry.execute("/login grok", ctx);

    expect(result.result).toContain("Grok subscription login successful");
    expect(authStorage.remove).toHaveBeenCalledWith("grok");
    expect(vi.mocked(loginGrok)).toHaveBeenCalledTimes(1);
    expect(prepareProvider).toHaveBeenCalledTimes(2);
  });

  it("/login grok fails without touching the session when browser OAuth is rejected", async () => {
    vi.mocked(loginGrok).mockClear().mockRejectedValueOnce(new Error("OAuth cancelled"));
    vi.mocked(importGrokCliCredentials).mockClear();
    const activeSession = createSessionStub({ model: "openai:gpt-4o" });
    const authStorage = createGrokAuthStorageStub();
    const registry = createGrokRegistryStub(authStorage);
    const ctx = createContext({ sessionManager: activeSession, registry });

    const result = await slashRegistry.execute("/login grok", ctx);

    expect(result.result).toBe("Error: OAuth cancelled");
    expect(authStorage.set).not.toHaveBeenCalled();
    expect(ctx.sessionManager).toBe(activeSession);
    expect(ctx.agent.setProvider).not.toHaveBeenCalled();
  });

  it("/login grok leaves a legacy Grok runtime session only after preparation succeeds", async () => {
    vi.mocked(loginGrok).mockClear();
    vi.mocked(importGrokCliCredentials).mockClear();
    const activeSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-existing" },
    });
    const freshSession = createSessionStub();
    const transitionToNative = vi.fn(async () => freshSession);
    const authStorage = createGrokAuthStorageStub();
    const registry = createGrokRegistryStub(authStorage);
    const ctx = createContext({
      sessionManager: activeSession,
      transitionToNative,
      registry,
      createProvider: vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() } as any)),
    });

    const result = await slashRegistry.execute("/login grok", ctx);

    expect(result.result).toContain("Grok subscription login successful");
    expect(transitionToNative).toHaveBeenCalledTimes(1);
    expect(ctx.sessionManager).toBe(freshSession);
  });

  it("/logout grok removes the stored login and cleans up a legacy runtime session", async () => {
    const calls: string[] = [];
    const oldSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-active" },
    });
    const freshSession = createSessionStub();
    const authStorage = createGrokAuthStorageStub(true);
    const onExternalRuntimeChange = vi.fn();
    const externalRuntime = {
      cancel: vi.fn(async () => { calls.push("cancel"); }),
      dispose: vi.fn(async () => { calls.push("dispose"); }),
      logout: vi.fn(async () => { calls.push("logout"); }),
    } as any;
    const ctx = createContext({
      sessionManager: oldSession,
      externalRuntime,
      registry: createGrokRegistryStub(authStorage),
      startFreshSession: vi.fn(async () => {
        calls.push("startFreshSession");
        return freshSession;
      }),
      onExternalRuntimeChange,
    });

    const result = await slashRegistry.execute("/logout grok", ctx);

    expect(result.result).toContain("Started a fresh native Bubble session");
    expect(authStorage.remove).toHaveBeenCalledWith("grok");
    expect(calls).toEqual(["cancel", "dispose", "logout", "startFreshSession"]);
    expect(externalRuntime.cancel).toHaveBeenCalledWith("grok-session-active");
    expect(freshSession.clearExternalRuntimeMetadata).toHaveBeenCalledTimes(1);
    expect(freshSession.appendMarker).toHaveBeenCalledWith("runtime_switch", "native");
    expect(ctx.sessionManager).toBe(freshSession);
    expect(onExternalRuntimeChange).toHaveBeenCalledWith(freshSession);
  });

  it("/logout grok from a native session removes only the stored login", async () => {
    const nativeSession = createSessionStub({ model: "openai:gpt-5.6" });
    const authStorage = createGrokAuthStorageStub(true);
    const externalRuntime = {
      logout: vi.fn(async () => undefined),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as any;
    const startFreshSession = vi.fn();
    const onExternalRuntimeChange = vi.fn();
    const ctx = createContext({
      sessionManager: nativeSession,
      externalRuntime,
      registry: createGrokRegistryStub(authStorage),
      startFreshSession,
      onExternalRuntimeChange,
    });

    const result = await slashRegistry.execute("/logout grok-subscription", ctx);

    expect(result.result).toContain("Only this device's local login was removed");
    expect(authStorage.remove).toHaveBeenCalledWith("grok");
    expect(externalRuntime.cancel).not.toHaveBeenCalled();
    expect(externalRuntime.dispose).not.toHaveBeenCalled();
    expect(startFreshSession).not.toHaveBeenCalled();
    expect(onExternalRuntimeChange).not.toHaveBeenCalled();
    expect(ctx.sessionManager).toBe(nativeSession);
  });

  it("/model in Grok mode opens the subscription model picker", async () => {
    const transitionToNative = vi.fn();
    const ctx = createContext({
      sessionManager: createSessionStub({
        externalRuntime: { id: "grok", sessionId: "grok-session-1" },
      }),
      transitionToNative,
    });

    const result = await slashRegistry.execute("/model", ctx);

    expect(result.result).toBeUndefined();
    expect(ctx.openPicker).toHaveBeenCalledWith("model");
    expect(transitionToNative).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", { id: "future-runtime", sessionId: "unknown-session" }],
    ["missing id", { sessionId: "malformed-session" }],
    ["null id", { id: null, sessionId: "malformed-session" }],
  ])("keeps %s external session metadata out of the native model path", async (_label, externalRuntime) => {
    const ctx = createContext({
      sessionManager: createSessionStub({ externalRuntime }),
    });

    const result = await slashRegistry.execute("/model", ctx);

    expect(result.result).toContain("runtime");
    expect(ctx.openPicker).not.toHaveBeenCalled();
    expect(ctx.agent.setProvider).not.toHaveBeenCalled();
  });

  it("/help in Grok mode exposes only the constrained local surface", async () => {
    const ctx = createContext({
      sessionManager: createSessionStub({
        externalRuntime: { id: "grok", sessionId: "grok-session-1" },
      }),
    });

    const result = await slashRegistry.execute("/help", ctx);

    expect(result.result).toContain("Grok Subscription · workspace tools · Bubble approvals");
    expect(result.result).toContain("/logout grok");
    expect(result.result).not.toContain("/memory");
    expect(result.result).not.toContain("/permissions");
    expect(result.result).not.toContain("/skills");
  });

  it("/model with an unusable target keeps Grok active after provider preparation fails", async () => {
    const calls: string[] = [];
    const activeSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-1" },
    });
    const freshSession = createSessionStub();
    const transitionToNative = vi.fn(async () => {
      calls.push("transitionToNative");
      return freshSession;
    });
    const ctx = createContext({
      sessionManager: activeSession,
      transitionToNative,
      registry: {
        getDefault: () => ({ id: "openai" }),
        prepareProvider: vi.fn(async () => { calls.push("prepareProvider"); }),
        getConfigured: () => [],
      } as any,
    });

    const result = await slashRegistry.execute("/model openai:gpt-5.6-terra", ctx);

    expect(calls).toEqual(["prepareProvider"]);
    expect(transitionToNative).not.toHaveBeenCalled();
    expect(ctx.sessionManager).toBe(activeSession);
    expect(result.result).toContain("not configured or has no active credentials");
  });

  it("/model rejects non-Ox OpenRouter ids before provider or session mutation", async () => {
    const prepareProvider = vi.fn(async () => undefined);
    const createProvider = vi.fn();
    const transitionToNative = vi.fn();
    const session = createSessionStub({ model: "openai:gpt-4o" });
    const ctx = createContext({
      sessionManager: session,
      transitionToNative,
      createProvider,
      registry: {
        getDefault: () => ({ id: "openai" }),
        prepareProvider,
        getConfigured: () => [],
      } as any,
    });

    const result = await slashRegistry.execute("/model openrouter:openai/gpt-5.6", ctx);

    expect(result.result).toMatch(/openrouter.*fixed.*stealth\/ox-alpha/i);
    expect(prepareProvider).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
    expect(transitionToNative).not.toHaveBeenCalled();
    expect(ctx.agent.model).toBe("openai:gpt-4o");
    expect(ctx.agent.providerId).toBe("openai");
    expect(ctx.agent.setProvider).not.toHaveBeenCalled();
    expect(session.updateMetadata).not.toHaveBeenCalled();
    expect(session.appendMarker).not.toHaveBeenCalled();
  });

  it("/provider opens without leaving or mutating the active Grok session", async () => {
    const activeSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-1" },
    });
    const transitionToNative = vi.fn();
    const ctx = createContext({
      sessionManager: activeSession,
      transitionToNative,
    });

    const result = await slashRegistry.execute("/provider", ctx);

    expect(result.result).toBeUndefined();
    expect(transitionToNative).not.toHaveBeenCalled();
    expect(ctx.sessionManager).toBe(activeSession);
    expect(ctx.openPicker).toHaveBeenCalledWith("provider");
  });

  it("/provider --list includes Grok without inspecting or leaving the active session", async () => {
    const activeSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-1" },
    });
    const transitionToNative = vi.fn();
    const inspect = vi.fn();
    const ctx = createContext({
      sessionManager: activeSession,
      transitionToNative,
      externalRuntime: { inspect } as any,
      registry: {
        getConfigured: () => [{
          id: "openai",
          name: "OpenAI",
          enabled: true,
          apiKey: "token",
          baseURL: "https://api.openai.com/v1",
        }],
        getDefault: () => ({ id: "openai" }),
        getModelConfig: () => ({ hasProvider: () => false, getLoadError: () => undefined }),
        getAuthStorage: () => ({ has: () => false }),
      } as any,
    });

    const result = await slashRegistry.execute("/provider --list", ctx);

    expect(result.result).toContain("Grok Subscription (grok)");
    expect(result.result).toContain("/login grok");
    expect(transitionToNative).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(ctx.sessionManager).toBe(activeSession);
  });

  it("/provider reserves Grok add/remove aliases without mutating registry or login state", async () => {
    const addProvider = vi.fn();
    const removeProvider = vi.fn();
    const setDefault = vi.fn();
    const login = vi.fn();
    const transitionToNative = vi.fn();
    const ctx = createContext({
      externalRuntime: { login } as any,
      transitionToNative,
      registry: { getEnabled: () => [], addProvider, removeProvider, setDefault } as any,
    });

    const add = await slashRegistry.execute("/provider --add grok", ctx);
    const remove = await slashRegistry.execute("/provider --remove grok-subscription", ctx);

    expect(add.result).toContain("built in");
    expect(remove.result).toContain("/logout grok");
    expect(addProvider).not.toHaveBeenCalled();
    expect(removeProvider).not.toHaveBeenCalled();
    expect(setDefault).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(transitionToNative).not.toHaveBeenCalled();
  });

  it("/login openai keeps the active Grok session when no usable model is available", async () => {
    const mockedLogin = vi.mocked(loginOpenAICodex);
    mockedLogin.mockClear();
    const activeSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-1" },
    });
    const transitionToNative = vi.fn();
    const authStorage = { set: vi.fn(), getPath: vi.fn(() => "/tmp/auth.json") };
    const ctx = createContext({
      sessionManager: activeSession,
      transitionToNative,
      registry: {
        supportsOAuth: () => true,
        getAuthStorage: () => authStorage,
        prepareProvider: vi.fn(),
        setDefault: vi.fn(),
        getConfigured: () => [],
        getDefaultModel: () => undefined,
      } as any,
    });

    const result = await slashRegistry.execute("/login openai", ctx);

    expect(transitionToNative).not.toHaveBeenCalled();
    expect(mockedLogin).toHaveBeenCalledTimes(1);
    expect(ctx.sessionManager).toBe(activeSession);
    expect(result.result).toContain("no default model is configured");
  });

  it("/login openai preserves the active Grok session when OAuth is cancelled", async () => {
    const mockedLogin = vi.mocked(loginOpenAICodex);
    mockedLogin.mockRejectedValueOnce(new Error("OAuth cancelled"));
    const activeSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-1" },
    });
    const transitionToNative = vi.fn();
    const ctx = createContext({
      sessionManager: activeSession,
      transitionToNative,
      registry: {
        supportsOAuth: () => true,
        getAuthStorage: vi.fn(),
      } as any,
    });

    const result = await slashRegistry.execute("/login openai", ctx);

    expect(result.result).toBe("Error: OAuth cancelled");
    expect(transitionToNative).not.toHaveBeenCalled();
    expect(ctx.sessionManager).toBe(activeSession);
  });

  it("/login openai leaves Grok only after OAuth, provider, and model preparation succeed", async () => {
    vi.stubEnv("BUBBLE_HOME", join(tmpdir(), `bubble-login-openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
    const calls: string[] = [];
    const mockedLogin = vi.mocked(loginOpenAICodex);
    mockedLogin.mockImplementationOnce(async () => {
      calls.push("oauth");
      return {
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        expiresAt: Date.now() + 60_000,
        accountId: "test-account",
      };
    });
    const activeSession = createSessionStub({
      externalRuntime: { id: "grok", sessionId: "grok-session-1" },
    });
    const freshSession = createSessionStub();
    const transitionToNative = vi.fn(async () => {
      calls.push("transitionToNative");
      return freshSession;
    });
    const authStorage = {
      set: vi.fn(() => { calls.push("saveCredentials"); }),
      getPath: vi.fn(() => "/tmp/auth.json"),
    };
    const provider = {
      id: "openai",
      name: "OpenAI",
      enabled: true,
      authType: "oauth",
      apiKey: "oauth-access",
      baseURL: "https://chatgpt.com/backend-api",
    };
    const setDefault = vi.fn(() => { calls.push("setDefault"); });
    const createProvider = vi.fn(() => {
      calls.push("createProvider");
      return { streamChat: vi.fn(), complete: vi.fn() } as any;
    });
    const ctx = createContext({
      sessionManager: activeSession,
      transitionToNative,
      createProvider,
      registry: {
        supportsOAuth: () => true,
        getAuthStorage: () => authStorage,
        prepareProvider: vi.fn(async () => { calls.push("prepareProvider"); }),
        setDefault,
        getConfigured: () => [provider],
        listModels: vi.fn(async () => {
          calls.push("listModels");
          return [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerId: "openai" }];
        }),
        getDefaultModel: () => undefined,
      } as any,
    });

    const result = await slashRegistry.execute("/login openai", ctx);
    vi.unstubAllEnvs();

    expect(result.result).toContain("OpenAI Codex OAuth login successful");
    expect(calls).toEqual([
      "oauth",
      "saveCredentials",
      "prepareProvider",
      "listModels",
      "createProvider",
      "transitionToNative",
      "setDefault",
    ]);
    expect(ctx.sessionManager).toBe(freshSession);
    expect(ctx.agent.setProvider).toHaveBeenCalledTimes(1);
  });

  it("opens the model dialog when no provider is configured so provider fallback can be shown", async () => {
    const ctx = createContext();
    const result = await slashRegistry.execute("/model", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(ctx.openPicker).toHaveBeenCalledWith("model");
  });

  it("opens the theme picker when /theme has no argument", async () => {
    const setThemeMode = vi.fn();
    const ctx = createContext({
      setThemeMode,
      getThemeMode: () => "auto",
      getResolvedTheme: () => "dark",
    });
    const result = await slashRegistry.execute("/theme", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(ctx.openPicker).toHaveBeenCalledWith("theme");
    expect(setThemeMode).not.toHaveBeenCalled();
  });

  it("sets the theme directly when /theme has an argument", async () => {
    const setThemeMode = vi.fn();
    const ctx = createContext({
      setThemeMode,
      getThemeMode: () => "auto",
      getResolvedTheme: () => "dark",
    });
    const result = await slashRegistry.execute("/theme light", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBe("Theme set to light.");
    expect(setThemeMode).toHaveBeenCalledWith("light");
    expect(ctx.openPicker).not.toHaveBeenCalled();
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

  it("/model distinguishes inherited defaults from explicit downward clamping", async () => {
    const originalBubbleHome = process.env.BUBBLE_HOME;
    const root = join(tmpdir(), `bubble-model-source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(root, { recursive: true });
    process.env.BUBBLE_HOME = root;

    try {
      const ctx = createContext({
        agent: {
          model: "openai:gpt-4o",
          providerId: "openai",
          thinking: "off",
          setSystemPrompt: vi.fn(),
          setProvider: vi.fn(),
        } as any,
        createProvider: vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() })) as any,
        registry: {
          getDefault: () => ({
            id: "openai",
            name: "OpenAI",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "token",
            enabled: true,
            authType: "oauth",
          }),
          getConfigured: () => [{
            id: "openai",
            name: "OpenAI",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "token",
            enabled: true,
            authType: "oauth",
          }],
          getModelConfig: () => ({ hasProvider: () => false }),
          prepareProvider: vi.fn(),
        } as any,
      });

      let result = await slashRegistry.execute("/model openai:gpt-5.6-terra", ctx);
      expect(result.result).toBe("Model switched to GPT-5.6-Terra.");
      expect(ctx.agent.thinking).toBe("medium");

      result = await slashRegistry.execute("/model openai:gpt-5.6-luna --reasoning-effort ultra", ctx);
      expect(result.result).toBe("Model switched to GPT-5.6-Luna (max).");
      expect(ctx.agent.thinking).toBe("max");

      const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf-8"));
      expect(saved.defaultModel).toBe("openai:gpt-5.6-luna");
      expect(saved.defaultThinkingLevel).toBe("max");
    } finally {
      if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = originalBubbleHome;
    }
  });

  it("/model hides default thinking level in the switch confirmation", async () => {
    const originalBubbleHome = process.env.BUBBLE_HOME;
    const root = join(tmpdir(), `bubble-model-label-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(root, { recursive: true });
    process.env.BUBBLE_HOME = root;

    try {
      const ctx = createContext({
        agent: {
          model: "openai:gpt-4o",
          providerId: "openai",
          thinking: "medium",
          setSystemPrompt: vi.fn(),
          setProvider: vi.fn(),
        } as any,
        createProvider: vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() })) as any,
        registry: {
          getDefault: () => ({
            id: "minimax",
            name: "MiniMax Token Plan",
            baseURL: "https://api.minimaxi.com/anthropic",
            apiKey: "sk-cp",
            enabled: true,
          }),
          getConfigured: () => [
            {
              id: "minimax",
              name: "MiniMax Token Plan",
              baseURL: "https://api.minimaxi.com/anthropic",
              apiKey: "sk-cp",
              enabled: true,
            },
            {
              id: "deepseek",
              name: "DeepSeek",
              baseURL: "https://api.deepseek.com",
              apiKey: "sk-deepseek",
              enabled: true,
            },
          ],
          getModelConfig: () => ({ hasProvider: () => false }),
          prepareProvider: vi.fn(),
        } as any,
      });

      let result = await slashRegistry.execute("/model minimax:MiniMax-M3", ctx);
      expect(result.result).toBe("Model switched to MiniMax M3.");

      result = await slashRegistry.execute("/model deepseek:deepseek-v4-pro --reasoning-effort max", ctx);
      expect(result.result).toBe("Model switched to deepseek-v4-pro (max).");
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

  it("/context opens the structured TUI panel instead of writing a transcript notice", async () => {
    const snapshot = {
      providerId: "openai",
      modelId: "gpt-4o",
      contextWindow: 128000,
      usedTokens: 3000,
      freeTokens: 125000,
      buckets: {
        systemPrompt: { label: "System prompt", tokens: 1000 },
        tools: { label: "Tools", tokens: 800 },
        skills: { label: "Skills", tokens: 500 },
        deferredTools: { label: "Deferred/MCP", tokens: 200 },
        other: { label: "Other", tokens: 500 },
      },
      toolCount: 2,
      deferredToolCount: 1,
      skillCount: 3,
      messageCount: 3,
    };
    const openContextInfo = vi.fn();
    const ctx = createContext({
      agent: {
        model: "openai:gpt-4o",
        providerId: "openai",
        thinking: "off",
        getContextUsageSnapshot: () => snapshot,
      } as any,
      openContextInfo,
    });

    const result = await slashRegistry.execute("/context", ctx);

    expect(result).toEqual({ handled: true, result: undefined });
    expect(openContextInfo).toHaveBeenCalledWith(snapshot);
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

  it("/compact streams an LLM summary, preserves optional context, and rebuilds agent history", async () => {
    const clearMessages = vi.fn();
    const resetContextUsageAnchor = vi.fn();
    const applyLLMCompaction = vi.fn(() => ({ compacted: true, droppedEntries: 2, summary: "LLM SUMMARY" }));
    const heuristicCompact = vi.fn(() => ({ compacted: true, droppedEntries: 2 }));
    const progress: Array<unknown> = [];
    // Fake streaming summarizer: emits two deltas, returns the final text.
    const summarizeForCompaction = vi.fn(async (
      _old: unknown,
      onDelta?: (full: string, d: string) => void,
      _signal?: AbortSignal,
      _userContext?: string,
    ) => {
      onDelta?.("part one", "part one");
      onDelta?.("part one two", " two");
      return "LLM SUMMARY";
    });
    const ctx = createContext({
      clearMessages,
      compactionProgress: (p) => progress.push(p),
      agent: {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "old prompt" },
        ],
        resetContextUsageAnchor,
        summarizeForCompaction,
      } as any,
      sessionManager: {
        getCompactionPlan: vi.fn(() => ({ oldMessages: [{ role: "user", content: "old prompt" }] })),
        applyLLMCompaction,
        compact: heuristicCompact,
        getMessages: vi.fn(() => [
          { role: "system", content: "Previous conversation summary:\nLLM SUMMARY" },
          { role: "user", content: "recent prompt" },
          { role: "assistant", content: "recent answer" },
        ]),
      } as any,
    });

    const result = await slashRegistry.execute("/compact keep the auth implementation", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toMatch(/^Compaction completed in (?:\d+ms|\d+\.\d+s)\.$/);
    expect(result.detail).toEqual({ kind: "compaction-summary", content: "LLM SUMMARY" });
    expect(summarizeForCompaction).toHaveBeenCalledTimes(1);
    expect(summarizeForCompaction.mock.calls[0]?.[3]).toBe("keep the auth implementation");
    expect(applyLLMCompaction).toHaveBeenCalledWith("LLM SUMMARY");
    expect(heuristicCompact).not.toHaveBeenCalled();
    expect(clearMessages).not.toHaveBeenCalled();
    // Progress was reported during the run and cleared (null) at the end.
    expect(progress.some((p) => (p as any)?.phase === "summarizing")).toBe(true);
    expect(progress[progress.length - 1]).toBeNull();
    expect(ctx.agent.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "system", content: "Previous conversation summary:\nLLM SUMMARY" },
      { role: "user", content: "recent prompt" },
      { role: "assistant", content: "recent answer" },
    ]);
    expect(resetContextUsageAnchor).toHaveBeenCalledTimes(1);
  });

  it("/compact falls back to heuristic compaction when the LLM summary fails", async () => {
    const applyLLMCompaction = vi.fn();
    const heuristicCompact = vi.fn(() => ({ compacted: true, droppedEntries: 1 }));
    const ctx = createContext({
      agent: {
        messages: [{ role: "system", content: "system prompt" }],
        resetContextUsageAnchor: vi.fn(),
        summarizeForCompaction: vi.fn(async () => { throw new Error("model down"); }),
      } as any,
      sessionManager: {
        getCompactionPlan: vi.fn(() => ({ oldMessages: [{ role: "user", content: "old" }] })),
        applyLLMCompaction,
        compact: heuristicCompact,
        getMessages: vi.fn(() => [{ role: "user", content: "recent" }]),
      } as any,
    });

    const result = await slashRegistry.execute("/compact", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toContain("Compaction completed in");
    expect(applyLLMCompaction).not.toHaveBeenCalled();
    expect(heuristicCompact).toHaveBeenCalledTimes(1);
  });

  it("/compact reports already-compact without calling the model", async () => {
    const summarizeForCompaction = vi.fn();
    const ctx = createContext({
      agent: {
        messages: [{ role: "system", content: "system prompt" }],
        resetContextUsageAnchor: vi.fn(),
        summarizeForCompaction,
      } as any,
      sessionManager: {
        getCompactionPlan: vi.fn(() => null),
        applyLLMCompaction: vi.fn(),
        compact: vi.fn(),
        getMessages: vi.fn(() => []),
      } as any,
    });

    const result = await slashRegistry.execute("/compact", ctx);

    expect(result.result).toContain("already compact");
    expect(summarizeForCompaction).not.toHaveBeenCalled();
  });

  it("/compact cancellation never falls through to heuristic compaction", async () => {
    const abortController = new AbortController();
    const heuristicCompact = vi.fn();
    const summarizeForCompaction = vi.fn(async (
      _old: unknown,
      _onDelta: unknown,
      signal?: AbortSignal,
    ) => {
      expect(signal).toBe(abortController.signal);
      abortController.abort();
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    const ctx = createContext({
      compactionAbortSignal: abortController.signal,
      agent: {
        messages: [{ role: "system", content: "system prompt" }],
        resetContextUsageAnchor: vi.fn(),
        summarizeForCompaction,
      } as any,
      sessionManager: {
        getCompactionPlan: vi.fn(() => ({ oldMessages: [{ role: "user", content: "old" }] })),
        applyLLMCompaction: vi.fn(),
        compact: heuristicCompact,
        getMessages: vi.fn(() => []),
      } as any,
    });

    const result = await slashRegistry.execute("/compact", ctx);

    expect(result.result).toBe("Compaction cancelled.");
    expect(heuristicCompact).not.toHaveBeenCalled();
    expect(ctx.agent.messages).toEqual([{ role: "system", content: "system prompt" }]);
  });

  it("/compact honours cancellation when a provider returns after ignoring abort", async () => {
    const abortController = new AbortController();
    const applyLLMCompaction = vi.fn();
    const heuristicCompact = vi.fn();
    const ctx = createContext({
      compactionAbortSignal: abortController.signal,
      agent: {
        messages: [{ role: "system", content: "system prompt" }],
        resetContextUsageAnchor: vi.fn(),
        summarizeForCompaction: vi.fn(async () => {
          abortController.abort();
          return "summary returned after abort";
        }),
      } as any,
      sessionManager: {
        getCompactionPlan: vi.fn(() => ({ oldMessages: [{ role: "user", content: "old" }] })),
        applyLLMCompaction,
        compact: heuristicCompact,
        getMessages: vi.fn(() => []),
      } as any,
    });

    const result = await slashRegistry.execute("/compact", ctx);

    expect(result.result).toBe("Compaction cancelled.");
    expect(applyLLMCompaction).not.toHaveBeenCalled();
    expect(heuristicCompact).not.toHaveBeenCalled();
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

  it("/clear resets agent context, display history, and records a session boundary", async () => {
    const appendMarker = vi.fn();
    const clearMessages = vi.fn();
    const resetContextUsageAnchor = vi.fn();
    const ctx = createContext({
      clearMessages,
      agent: {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "meta", kind: "system-reminder", content: "tool reminder" },
          { role: "user", content: "old prompt" },
          { role: "assistant", content: "old answer" },
        ],
        resetContextUsageAnchor,
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
    expect(appendMarker).toHaveBeenCalledWith("conversation_clear", "");
    expect(clearMessages).toHaveBeenCalledTimes(1);
    expect(resetContextUsageAnchor).toHaveBeenCalledTimes(1);
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
        resetContextUsageAnchor: vi.fn(),
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

describe("/session", () => {
  async function withSessionFixture(run: (fixture: { cwd: string }) => Promise<void>) {
    const previousHome = process.env.BUBBLE_HOME;
    const root = join(tmpdir(), `bubble-session-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    process.env.BUBBLE_HOME = root;
    try {
      await run({ cwd: join(root, "project") });
    } finally {
      if (previousHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previousHome;
    }
  }

  it("opens the session picker when the host provides one", async () => {
    const openSessionPicker = vi.fn();
    const ctx = createContext({ openSessionPicker });

    const result = await slashRegistry.execute("/session", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBeUndefined();
    expect(openSessionPicker).toHaveBeenCalled();
  });

  it("falls back to a text listing when no picker is available", async () => {
    await withSessionFixture(async ({ cwd }) => {
      const { SessionManager } = await import("../session.js");
      const session = SessionManager.create(cwd, "2026-06-13T08-00-00-000Z.jsonl");
      session.setMetadata({ cwd, title: "Refactor the parser" });
      session.appendMessage({ role: "user", content: "refactor the parser please" });

      const ctx = createContext({ cwd });
      const result = await slashRegistry.execute("/session", ctx);

      expect(result.handled).toBe(true);
      expect(result.result).toContain("Recent sessions:");
      expect(result.result).toContain("Refactor the parser");
      expect(result.result).toContain("bubble --resume --session");
    });
  });

  it("marks the active session in /session --list", async () => {
    await withSessionFixture(async ({ cwd }) => {
      const { SessionManager } = await import("../session.js");
      const current = SessionManager.create(cwd, "2026-06-13T09-00-00-000Z.jsonl");
      current.setMetadata({ cwd, title: "Active conversation" });
      current.appendMessage({ role: "user", content: "hello" });

      const ctx = createContext({ cwd, sessionManager: current });
      const result = await slashRegistry.execute("/session --list", ctx);

      expect(result.handled).toBe(true);
      expect(result.result).toContain("Active conversation");
      expect(result.result).toContain("(current)");
    });
  });

  it("reports when the project has no sessions yet", async () => {
    await withSessionFixture(async ({ cwd }) => {
      const ctx = createContext({ cwd });
      const result = await slashRegistry.execute("/session", ctx);

      expect(result.handled).toBe(true);
      expect(result.result).toBe("No sessions recorded for this project yet.");
    });
  });

  it("rejects unknown arguments with a usage hint", async () => {
    const ctx = createContext();
    const result = await slashRegistry.execute("/session bogus", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toContain("Usage: /session");
  });
});

describe("/mcp status listing", () => {
  const states = [
    {
      name: "zai",
      scope: "user",
      config: { type: "stdio" },
      status: {
        kind: "connected",
        tools: Array.from({ length: 14 }, (_, i) => ({ name: `tool_${i}`, description: `does thing ${i}` })),
        prompts: [],
        serverInfo: { name: "zai-server", version: "1.0.0" },
      },
    },
    {
      name: "computer-use",
      scope: "user",
      config: { type: "http" },
      status: { kind: "failed", error: "fetch failed: ECONNREFUSED" },
    },
  ];
  const mcpManager = { getStates: () => states } as any;

  it("collapses connected servers to a one-line summary with tool count", async () => {
    const ctx = createContext({ mcpManager });
    const result = await slashRegistry.execute("/mcp", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toContain("✔ zai — connected · 14 tools");
    // Individual tools stay behind /mcp tools <name>.
    expect(result.result).not.toContain("tool_0");
  });

  it("renders failures bold and uppercase with the error and a retry hint", async () => {
    const ctx = createContext({ mcpManager });
    const result = await slashRegistry.execute("/mcp", ctx);

    expect(result.result).toContain("**✘ computer-use — UNABLE TO CONNECT**");
    expect(result.result).toContain("fetch failed: ECONNREFUSED");
    expect(result.result).toContain("retry: /mcp reconnect computer-use");
  });

  it("lists individual tools via /mcp tools <name>", async () => {
    const ctx = createContext({ mcpManager });
    const result = await slashRegistry.execute("/mcp tools zai", ctx);

    expect(result.result).toContain("Tools from zai (14):");
    expect(result.result).toContain("tool_0");
  });

  it("refuses /mcp tools for a server that is not connected", async () => {
    const ctx = createContext({ mcpManager });
    const result = await slashRegistry.execute("/mcp tools computer-use", ctx);

    expect(result.result).toContain("not connected");
    expect(result.result).toContain("/mcp reconnect computer-use");
  });
});

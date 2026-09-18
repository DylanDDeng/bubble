import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { PiTuiApp } from "../tui/app.js";
import { loginOpenAICodex } from "../oauth/openai-codex.js";
import { loginGrok } from "../oauth/grok.js";
import type { DisplayMessage } from "../tui/model/display-history.js";

vi.mock("../oauth/openai-codex.js", () => ({
  loginOpenAICodex: vi.fn(async () => { throw new Error("openai login stub reached"); }),
}));
vi.mock("../oauth/grok.js", () => ({
  loginGrok: vi.fn(async () => { throw new Error("grok login stub reached"); }),
  importGrokCliCredentials: vi.fn(() => undefined),
}));

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";

function createApp(signedIn: string[] = [], externalRuntime?: unknown) {
  const terminal = new VirtualTerminal(100, 30);
  let messages: DisplayMessage[] = [];
  const remove = vi.fn();
  let notifyTranscriptChanged = () => {};
  const controller = {
    subscribe: (listener: () => void) => {
      notifyTranscriptChanged = listener;
      return () => { notifyTranscriptChanged = () => {}; };
    },
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
    appendDisplayMessage: (message: DisplayMessage) => {
      messages = [...messages, message];
      notifyTranscriptChanged();
    },
    clearTranscript: () => {},
    shutdown: () => ({ reason: "test", wallMs: 0 }),
  };
  const authStorage = {
    has: (id: string) => signedIn.includes(id),
    remove,
    set: vi.fn(),
    getPath: () => "/tmp/auth.json",
  };
  const registry = {
    getAuthStorage: () => authStorage,
    // Mirrors ProviderRegistry: `openai` may be backed by legacy `openai-codex`.
    getOAuthLoginKeys: (id: string) =>
      (id === "openai" ? ["openai", "openai-codex"] : [id]).filter((key) => signedIn.includes(key)),
    supportsOAuth: (id: string) => id === "openai" || id === "grok",
    getConfigured: () => [],
    getDefault: () => undefined,
    getEnabledProviders: () => [],
    getModelConfig: () => ({ hasProvider: () => false }),
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
    sessionManager: { getSessionFile: () => "/login.jsonl", getMetadata: () => ({ externalRuntime }) } as never,
    controller: controller as never,
    registry: registry as never,
    callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
    terminal,
  });
  const viewport = () => terminal.getViewport().join("\n");
  return { app, terminal, viewport, remove };
}

/** Submit the bare command itself, not the highlighted slash-menu row. */
async function submitBare(terminal: VirtualTerminal, command: string) {
  terminal.sendInput(command);
  terminal.sendInput(ESC);
  terminal.sendInput(ENTER);
}

describe("main pi-tui /login and /logout account picker", () => {
  beforeEach(() => {
    vi.mocked(loginOpenAICodex).mockClear();
    vi.mocked(loginGrok).mockClear();
  });

  it("bare /login opens the account menu and starts no OAuth flow", async () => {
    const { app, terminal, viewport } = createApp();
    app.start();
    try {
      await submitBare(terminal, "/login");
      await vi.waitFor(() => {
        expect(viewport()).toContain("OpenAI");
        expect(viewport()).toContain("Grok Subscription");
        expect(viewport()).toContain("Not signed in");
      });
      expect(loginOpenAICodex).not.toHaveBeenCalled();
      expect(loginGrok).not.toHaveBeenCalled();
    } finally {
      app.dispose();
    }
  });

  it("runs the login the user picks from the menu, not a default", async () => {
    const { app, terminal, viewport } = createApp();
    app.start();
    try {
      await submitBare(terminal, "/login");
      await vi.waitFor(() => expect(viewport()).toContain("Grok Subscription"));
      terminal.sendInput(DOWN);
      terminal.sendInput(ENTER);
      await vi.waitFor(() => expect(loginGrok).toHaveBeenCalledTimes(1));
      expect(loginOpenAICodex).not.toHaveBeenCalled();
    } finally {
      app.dispose();
    }
  });

  it("selecting /login from the slash menu also lands on the account menu", async () => {
    const { app, terminal, viewport } = createApp();
    app.start();
    try {
      terminal.sendInput("/login");
      await vi.waitFor(() => expect(viewport()).toContain("/login"));
      terminal.sendInput(ENTER);
      await vi.waitFor(() => expect(viewport()).toContain("Grok Subscription"));
      expect(loginOpenAICodex).not.toHaveBeenCalled();
    } finally {
      app.dispose();
    }
  });

  it("bare /logout shows sign-in state and removes nothing until an account is picked", async () => {
    const { app, terminal, viewport, remove } = createApp(["openai"]);
    app.start();
    try {
      await submitBare(terminal, "/logout");
      await vi.waitFor(() => {
        expect(viewport()).toContain("Signed in");
        expect(viewport()).toContain("nothing to remove");
      });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      app.dispose();
    }
  });

  it("treats legacy openai-codex credentials as the OpenAI login and removes them", async () => {
    const { app, terminal, viewport, remove } = createApp(["openai-codex"]);
    app.start();
    try {
      await submitBare(terminal, "/logout");
      await vi.waitFor(() => expect(viewport()).toContain("removes this device's credentials"));
      terminal.sendInput(ENTER);
      await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("openai-codex"));
    } finally {
      app.dispose();
    }
  });

  it("submits a typed account id the menu does not list instead of swallowing Enter", async () => {
    const { app, terminal, viewport } = createApp();
    app.start();
    try {
      terminal.sendInput("/login nope");
      await vi.waitFor(() => expect(viewport()).toContain("/login nope"));
      terminal.sendInput(ENTER);
      await vi.waitFor(() => expect(viewport()).toContain("Unsupported login provider: nope"));
    } finally {
      app.dispose();
    }
  });

  it("accepts the canonical grok-subscription id typed by hand", async () => {
    const { app, terminal, viewport } = createApp();
    app.start();
    try {
      terminal.sendInput("/login grok-subscription");
      await vi.waitFor(() => expect(viewport()).toContain("Grok Subscription"));
      terminal.sendInput(ENTER);
      await vi.waitFor(() => expect(loginGrok).toHaveBeenCalledTimes(1));
    } finally {
      app.dispose();
    }
  });
});

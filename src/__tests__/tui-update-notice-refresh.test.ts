import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { PiTuiApp } from "../tui/app.js";
import type { DisplayMessage } from "../tui/model/display-history.js";

const LATE_NOTICE = "Update available: v0.0.52 → v99.0.0 · run `bubble update`";

function deferredNotice() {
  let resolve!: (notice: string | null) => void;
  const promise = new Promise<string | null>((done) => { resolve = done; });
  return { promise, resolve };
}

function controllerHarness(initialMessages: DisplayMessage[] = []) {
  let messages = [...initialMessages];
  let notify = () => {};
  const controller = {
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => { notify = () => {}; };
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
      notify();
    },
    clearTranscript: () => {},
    shutdown: () => ({ reason: "test", wallMs: 0 }),
  };
  return { controller, messages: () => messages };
}

function createApp(
  terminal: VirtualTerminal,
  controller: ReturnType<typeof controllerHarness>["controller"],
  updateNoticeRefresh: Promise<string | null>,
) {
  return new PiTuiApp({
    agent: {
      model: "test-model",
      providerId: "test-provider",
      thinking: "off",
      mode: "default",
      setMode: () => {},
      getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
    } as never,
    sessionManager: { getSessionFile: () => "/update-notice.jsonl" } as never,
    controller: controller as never,
    callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
    terminal,
    updateNoticeRefresh,
  });
}

describe("pi-tui late update notice", () => {
  it("updates the welcome banner when the session is still empty", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const refresh = deferredNotice();
    const harness = controllerHarness();
    const app = createApp(terminal, harness.controller, refresh.promise);

    app.start();
    try {
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).not.toContain(LATE_NOTICE);

      refresh.resolve(LATE_NOTICE);

      await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain(LATE_NOTICE));
      expect(harness.messages()).toEqual([]);
    } finally {
      app.dispose();
    }
  });

  it("appends a visible transcript notice when a conversation already exists", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const refresh = deferredNotice();
    const harness = controllerHarness([{ key: "user-1", role: "user", content: "existing request" }]);
    const app = createApp(terminal, harness.controller, refresh.promise);

    app.start();
    try {
      await terminal.waitForRender();
      refresh.resolve(LATE_NOTICE);

      await vi.waitFor(() => {
        expect(harness.messages().at(-1)).toEqual(expect.objectContaining({
          role: "assistant",
          content: LATE_NOTICE,
          syntheticKind: "ui_notice",
        }));
      });
      await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain(LATE_NOTICE));
    } finally {
      app.dispose();
    }
  });

  it("ignores a refresh that resolves after the app is disposed", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const refresh = deferredNotice();
    const harness = controllerHarness([{ key: "user-1", role: "user", content: "existing request" }]);
    const app = createApp(terminal, harness.controller, refresh.promise);

    app.start();
    await terminal.waitForRender();
    app.dispose();
    refresh.resolve(LATE_NOTICE);
    await refresh.promise;
    await Promise.resolve();

    expect(harness.messages()).toHaveLength(1);
  });
});

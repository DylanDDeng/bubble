import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { PiTuiApp } from "../tui/app.js";
import { QuestionController, QuestionRejectedError } from "../question/index.js";
import { BashAllowlist } from "../approval/session-cache.js";
import type { StreamingTailState } from "../tui/components/streaming-message.js";
import type { DisplayMessage } from "../tui/model/display-history.js";
import type { PlanDecision } from "../types.js";
import type { FeedbackPayload, SubmitResult } from "../feedback/types.js";

class RecordingTerminal extends VirtualTerminal {
  readonly output: string[] = [];

  override write(data: string): void {
    this.output.push(data);
    super.write(data);
  }
}

describe("main pi-tui running input", () => {
  it("keeps an image chip inline when the composer draft becomes a sent message", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const messages: DisplayMessage[] = [];
    const submitted: unknown[] = [];
    const controller = {
      subscribe: () => () => {},
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
      runTurn: async (input: unknown) => { submitted.push(input); },
      appendDisplayMessage: (message: DisplayMessage) => { messages.push(message); },
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const app = new PiTuiApp({
      agent: {
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
      readClipboardImage: async () => ({
        attachment: {
          base64: "cG5n",
          mediaType: "image/png",
          bytes: 3,
          dataUrl: "data:image/png;base64,cG5n",
        },
      }),
    });

    app.start();
    try {
      terminal.sendInput("\x16");
      await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("[Image #1]"));
      terminal.sendInput("这在干嘛");
      await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("这在干嘛"));
      terminal.sendInput("\r");
      await vi.waitFor(() => expect(submitted).toHaveLength(1));

      const viewport = terminal.getViewport();
      expect(viewport.join("\n")).toContain("[Image #1] 这在干嘛");
      expect(viewport.join("\n")).not.toContain("└ [Image #1]");
      expect(messages[0]?.content).toBe("[Image #1] 这在干嘛");
    } finally {
      app.dispose();
    }
  });

  it("routes Ctrl+V and reportable Cmd+V to the image clipboard reader", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const readClipboardImage = vi.fn(async () => ({
      attachment: {
        base64: "cG5n",
        mediaType: "image/png",
        bytes: 3,
        dataUrl: "data:image/png;base64,cG5n",
        filename: "clipboard.png",
      },
    }));
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
      readClipboardImage,
    });

    app.start();
    try {
      terminal.sendInput("\x16");
      await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("[Image #1]"));

      // Kitty keyboard protocol encodes Command as the Super modifier (8 + 1).
      terminal.sendInput("\x1b[118;9u");
      await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("[Image #2]"));
      expect(readClipboardImage).toHaveBeenCalledTimes(2);
    } finally {
      app.dispose();
    }
  });

  it("opens the completed subagent inspector by double-clicking its transcript trace", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const member = {
      subAgentId: "child-1",
      nickname: "Karen",
      agentName: "explorer",
      status: "completed",
      summary: "full review details",
    };
    const messages: DisplayMessage[] = [{
      key: "launch",
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "spawn",
        name: "spawn_agent",
        args: {},
        result: "finished",
        status: "completed",
        metadata: { kind: "subagent", subagents: [member] },
      }],
    }];
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => messages,
      getSubagentGroups: () => [{ id: "single:child-1", kind: "single", label: "Karen", members: [member] }],
      getWorkflows: () => [],
      getBackgroundTasks: () => [],
      getChildTranscript: () => [{ key: "review", role: "assistant", content: "full review details" }],
      getChildStreamingTail: () => null,
      stopSubagent: () => {},
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
      await terminal.waitForRender();
      const traceRow = terminal.getViewport().findIndex((row) => row.includes("Subagent Karen completed"));
      expect(traceRow).toBeGreaterThanOrEqual(0);
      const y = traceRow + 1;
      terminal.sendInput(`\x1b[<0;5;${y}M`);
      terminal.sendInput(`\x1b[<0;5;${y}m`);
      terminal.sendInput(`\x1b[<0;5;${y}M`);
      terminal.sendInput(`\x1b[<0;5;${y}m`);
      await terminal.waitForRender();

      const inspector = terminal.getViewport().join("\n");
      expect(inspector).toContain("Karen — read only");
      expect(inspector).toContain("full review details");
    } finally {
      app.dispose();
    }
  });

  it("opens Tasks Pane with Ctrl+G and returns typing focus to composer after closing", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      getSubagentGroups: () => [{
        id: "single:child-1",
        runId: "run-1",
        kind: "single",
        label: "Ada",
        members: [{ subAgentId: "child-1", nickname: "Ada", status: "running", task: "review the code" }],
      }],
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
      await terminal.waitForRender();
      const initialRows = terminal.getViewport();
      expect(initialRows.join("\n")).toContain("Subagents");
      expect(initialRows.findIndex((row) => row.includes("Subagents")))
        .toBeGreaterThan(initialRows.findIndex((row) => row.includes("I am a cat")));
      terminal.resize(20, 10);
      await terminal.waitForRender();
      terminal.sendInput("R");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("R");
      terminal.resize(100, 30);
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Subagents");
      terminal.sendInput("\x07");
      await terminal.waitForRender();
      terminal.sendInput("\x07");
      terminal.sendInput("Q");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Q");
    } finally {
      app.dispose();
    }
  });

  it("enters fullscreen before the first product frame and keeps the complete app surface mounted", async () => {
    const terminal = new RecordingTerminal(100, 30);
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
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
        model: "test-model",
        providerId: "test-provider",
        thinking: "medium",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      terminal,
    });

    app.start();
    let writesBeforeDispose = 0;
    try {
      await terminal.waitForRender();
      const output = terminal.output.join("");
      const altScreenEntry = output.indexOf("\x1b[?1049h");
      expect(altScreenEntry).toBeGreaterThanOrEqual(0);
      expect(output.slice(0, altScreenEntry)).not.toContain("I am a cat");
      const initialViewport = terminal.getViewport().join("\n");
      expect(initialViewport).toContain("I am a cat");
      expect(initialViewport).toContain("┌");
      expect(initialViewport).toContain("│ >");
      expect(initialViewport).toContain("└");

      terminal.sendInput("/he");
      await terminal.waitForRender();
      const viewport = terminal.getViewport().join("\n");
      expect(viewport).toContain("Show available slash commands");
      expect(viewport).not.toContain("Open the alternate-screen transcript view");
      writesBeforeDispose = terminal.output.length;
    } finally {
      app.dispose();
    }
    const exitOutput = terminal.output.slice(writesBeforeDispose).join("");
    expect(exitOutput).toContain("\x1b[?1049l");
    expect(exitOutput).not.toContain("\x1b[2K");
    expect(exitOutput).not.toContain("I am a cat");
  });

  it("keeps the first Thinking surface fixed when the user turn settles", async () => {
    const terminal = new VirtualTerminal(204, 68);
    const listeners: Array<() => void> = [];
    const reasoning = [
      "Inspect the request and current workspace state before answering.",
      "Keep the response concise while preserving the relevant implementation context.",
      "Verify the final wording and then return the answer.",
    ].join(" ").repeat(2);
    const answer = "Ready to help with the Pi TUI implementation.";
    let messages: DisplayMessage[] = [{ key: "user", role: "user", content: "hello" }];
    let running = true;
    let tail: StreamingTailState | null = {
      content: "",
      reasoning,
      tools: [],
      parts: [],
      phase: "thinking",
    };
    const controller = {
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      getTranscript: () => messages,
      isRunning: () => running,
      getStreamingTail: () => tail,
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
        model: "test-model",
        providerId: "test-provider",
        thinking: "medium",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      terminal,
    });
    const geometry = () => {
      const rows = terminal.getViewport();
      const thinkingAt = rows.findIndex((row) => row.includes("◆ Thinking"));
      let reasoningEndAt = -1;
      for (let index = 0; index < rows.length; index += 1) {
        if (rows[index]!.includes("┃")) reasoningEndAt = index;
      }
      const composerAt = rows.findIndex((row) => row.includes("┌"));
      expect(thinkingAt).toBeGreaterThanOrEqual(0);
      expect(reasoningEndAt).toBeGreaterThanOrEqual(thinkingAt);
      expect(composerAt).toBeGreaterThan(reasoningEndAt);
      return {
        thinkingAt,
        headerDistance: composerAt - thinkingAt,
        bodyDistance: composerAt - reasoningEndAt,
      };
    };

    app.start();
    try {
      await terminal.waitForRender();
      const liveReasoning = geometry();

      tail = {
        content: answer,
        reasoning,
        tools: [],
        parts: [{ type: "text", content: answer }],
        phase: "thinking",
      };
      for (const listener of listeners) listener();
      await terminal.waitForRender();
      expect(geometry()).toEqual(liveReasoning);

      messages = [...messages, { key: "assistant", role: "assistant", content: answer, reasoning }];
      running = false;
      tail = null;
      for (const listener of listeners) listener();
      await terminal.waitForRender();
      expect(geometry()).toEqual(liveReasoning);
    } finally {
      app.dispose();
    }
  });

  it("cycles permission modes with Shift+Tab and reflects them in the footer", async () => {
    const terminal = new VirtualTerminal(100, 14);
    const modes: string[] = [];
    const agent = {
      model: "test-model",
      providerId: "test-provider",
      thinking: "medium",
      mode: "default",
      setMode(next: string) {
        this.mode = next;
        modes.push(next);
      },
      getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
    };
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      isRunning: () => false,
      getStreamingTail: () => ({ content: "", reasoning: "", tools: [], parts: [], phase: "idle" as const }),
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
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      terminal,
      uiMode: "regular",
    });

    app.start();
    try {
      terminal.sendInput("\x1b[Z");
      await terminal.waitForRender();
      expect(modes).toEqual(["plan"]);
      expect(terminal.getViewport().join("\n")).toContain("⏸ plan on");

      terminal.sendInput("\x1b[Z");
      await terminal.waitForRender();
      expect(modes).toEqual(["plan", "bypassPermissions"]);
      expect(terminal.getViewport().join("\n")).toContain("⏵⏵ bypass permission on");

      terminal.sendInput("\x1b[Z");
      await terminal.waitForRender();
      expect(modes).toEqual(["plan", "bypassPermissions", "default"]);
    } finally {
      app.dispose();
    }
  });

  it("steers and cancels the active run without starting another turn or exiting", async () => {
    const terminal = new VirtualTerminal(80, 14);
    const steers: string[] = [];
    let cancellations = 0;
    let exits = 0;
    let runCalls = 0;
    let controllerUnsubscribed = 0;
    let questionUnsubscribed = 0;
    const controller = {
      subscribe: () => () => { controllerUnsubscribed += 1; },
      getTranscript: () => [],
      isRunning: () => true,
      getStreamingTail: () => ({ content: "", reasoning: "", tools: [], parts: [], phase: "thinking" as const }),
      pendingSteerCount: () => steers.length,
      queuedInputCount: () => 0,
      steer: (content: string) => { steers.push(content); return true; },
      cancelActiveRun: () => { cancellations += 1; return true; },
      runTurn: async () => { runCalls += 1; },
      appendDisplayMessage: () => {},
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const agent = {
      model: "test-model",
      providerId: "test-provider",
      thinking: "medium",
      getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
    };
    const app = new PiTuiApp({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => { exits += 1; },
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      questionController: {
        subscribe: () => () => { questionUnsubscribed += 1; },
        rejectAll: () => {},
      } as never,
      terminal,
      uiMode: "regular",
    });

    app.start();
    terminal.sendInput("follow up");
    terminal.sendInput("\r");
    await terminal.waitForRender();

    expect(steers).toEqual(["follow up"]);
    expect(runCalls).toBe(0);

    terminal.sendInput("\x03");
    expect(cancellations).toBe(1);
    expect(exits).toBe(0);
    terminal.sendInput("\x1b");
    expect(cancellations).toBe(2);
    expect(exits).toBe(0);

    // Escape/Ctrl+C are encoded once extended keyboard protocols are active.
    terminal.sendInput("\x1b[27;1;27~");
    expect(cancellations).toBe(3);
    terminal.sendInput("\x1b[27u");
    expect(cancellations).toBe(4);
    terminal.sendInput("\x1b[99;5u");
    expect(cancellations).toBe(5);
    // Kitty release events must not invoke the global shortcut a second time.
    terminal.sendInput("\x1b[27;1:3u");
    expect(cancellations).toBe(5);
    expect(exits).toBe(0);

    terminal.sendInput("/fullscreen");
    terminal.sendInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.dispose();
    expect(exits).toBe(1);
    // Main + alternate-screen controller subscriptions are both released.
    expect(controllerUnsubscribed).toBe(2);
    expect(questionUnsubscribed).toBe(1);
  });

  it("returns keyboard focus to the composer after approving or denying a tool", async () => {
    const terminal = new VirtualTerminal(80, 14);
    const turns: string[] = [];
    const modes: string[] = [];
    const bashAllowlist = new BashAllowlist();
    let running = false;
    let cancelCalls = 0;
    const approvalHandlerRef: { current?: (request: unknown) => Promise<unknown> } = {};
    const planHandlerRef: { current?: (plan: string) => Promise<PlanDecision> } = {};
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      isRunning: () => running,
      getStreamingTail: () => ({ content: "", reasoning: "", tools: [], parts: [], phase: "idle" as const }),
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => {
        cancelCalls += 1;
        return running;
      },
      runTurn: async (content: string) => { turns.push(content); },
      appendDisplayMessage: () => {},
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const agent = {
      model: "test-model",
      providerId: "test-provider",
      thinking: "medium",
      mode: "default",
      setMode(next: string) {
        this.mode = next;
        modes.push(next);
      },
      getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
    };
    const app = new PiTuiApp({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      approvalHandlerRef: approvalHandlerRef as never,
      bashAllowlist,
      planHandlerRef,
      terminal,
      uiMode: "regular",
    });

    app.start();
    try {
      const approved = approvalHandlerRef.current!({ type: "bash", command: "pwd", cwd: "/workspace" });
      await terminal.waitForRender();
      const approvalViewport = terminal.getViewport().join("\n");
      expect(approvalViewport).toContain("Request approval for pwd");
      expect(approvalViewport).toContain("working directory: /workspace");
      expect(approvalViewport).toContain("1 (●) Yes, proceed");
      expect(approvalViewport).toContain("2 (○) Yes, don't ask again");
      expect(approvalViewport).not.toContain("Tool approval");
      terminal.sendInput("\r");
      await expect(approved).resolves.toEqual({ action: "approve" });

      terminal.sendInput("fourth message");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(turns).toEqual(["fourth message"]);

      const denied = approvalHandlerRef.current!({ type: "bash", command: "ls", cwd: "/workspace" });
      running = true;
      terminal.sendInput("\x1b");
      await expect(denied).resolves.toEqual({ action: "reject", feedback: "User denied the tool call." });
      expect(cancelCalls).toBe(0);
      running = false;

      terminal.sendInput("fifth message");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(turns).toEqual(["fourth message", "fifth message"]);

      const planApproved = planHandlerRef.current!("1. inspect\n2. implement");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Proposed plan");
      terminal.sendInput("\r");
      await expect(planApproved).resolves.toEqual({
        action: "approve",
        plan: "1. inspect\n2. implement",
      });

      const planEdited = planHandlerRef.current!("1. inspect\n2. implement");
      terminal.sendInput("e");
      terminal.sendInput(" carefully");
      terminal.sendInput("\x13");
      await expect(planEdited).resolves.toEqual({
        action: "approve",
        plan: "1. inspect\n2. implement carefully",
      });

      const planEditCancelled = planHandlerRef.current!("keep original");
      terminal.sendInput("e");
      terminal.sendInput(" changed");
      terminal.sendInput("\x1b");
      terminal.sendInput("\r");
      await expect(planEditCancelled).resolves.toEqual({ action: "approve", plan: "keep original" });

      const planRejected = planHandlerRef.current!("reject this");
      terminal.sendInput("\x1b");
      await expect(planRejected).resolves.toEqual({
        action: "reject",
        reason: "User rejected the plan.",
      });

      terminal.sendInput("sixth message");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(turns).toEqual(["fourth message", "fifth message", "sixth message"]);

      const alwaysApproved = approvalHandlerRef.current!({
        type: "bash",
        command: "npm run build",
        cwd: "/workspace",
      });
      terminal.sendInput("\t");
      terminal.sendInput("\r");
      await expect(alwaysApproved).resolves.toEqual({ action: "approve" });
      expect(bashAllowlist.list()).toEqual(["npm run"]);
      expect(bashAllowlist.matches("npm run test")).toBe(true);
      expect(bashAllowlist.matches("git status")).toBe(false);
      expect(modes).toEqual([]);
    } finally {
      app.dispose();
    }
  });

  it("opens /feedback in place, submits the reviewed payload, and restores composer focus", async () => {
    const terminal = new VirtualTerminal(100, 22);
    const turns: string[] = [];
    const transcript: DisplayMessage[] = [];
    const submitFeedback = vi.fn<(payload: FeedbackPayload) => Promise<SubmitResult>>(async () => ({
      url: "https://github.com/DylanDDeng/bubble/issues/88",
      number: 88,
    }));
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => transcript,
      isRunning: () => false,
      getStreamingTail: () => null,
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => false,
      runTurn: async (content: string) => { turns.push(content); },
      appendDisplayMessage: (message: DisplayMessage) => { transcript.push(message); },
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const agent = {
      messages: [
        { role: "user", content: "previous question" },
        { role: "assistant", content: "previous answer", toolCalls: [] },
      ],
      model: "test-model",
      providerId: "test-provider",
      thinking: "medium",
      mode: "default",
      getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
    };
    const app = new PiTuiApp({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      submitFeedback,
      terminal,
      uiMode: "regular",
    });

    app.start();
    try {
      terminal.sendInput("/feedback cursor jumps after submit");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Send feedback");
      expect(terminal.getViewport().join("\n")).toContain("PUBLIC GitHub issue");

      terminal.sendInput("\t");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Payload preview");
      expect(terminal.getViewport().join("\n")).toContain("cursor jumps after submit");
      terminal.sendInput("\t");
      terminal.sendInput("\x13");

      await vi.waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
      await terminal.waitForRender();
      expect(submitFeedback.mock.calls[0]![0].description).toBe("cursor jumps after submit");
      expect(submitFeedback.mock.calls[0]![0].transcript).toHaveLength(2);
      expect(terminal.getViewport().join("\n")).toContain("Issue #88 was created");
      expect(transcript.at(-1)).toMatchObject({
        role: "assistant",
        content: "Feedback submitted: https://github.com/DylanDDeng/bubble/issues/88",
      });

      terminal.sendInput("\r");
      terminal.sendInput("after feedback");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(turns).toEqual(["after feedback"]);
    } finally {
      app.dispose();
    }
  });

  it("renders structured questions, returns choices, and keeps modal Escape away from run cancellation", async () => {
    const terminal = new VirtualTerminal(100, 18);
    const questionController = new QuestionController();
    const turns: string[] = [];
    let running = false;
    let cancelCalls = 0;
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      isRunning: () => running,
      getStreamingTail: () => running
        ? ({ content: "", reasoning: "", tools: [], parts: [], phase: "thinking" as const })
        : null,
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => { cancelCalls += 1; return running; },
      runTurn: async (content: string) => { turns.push(content); },
      appendDisplayMessage: () => {},
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const app = new PiTuiApp({
      agent: {
        model: "test-model",
        providerId: "test-provider",
        thinking: "medium",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      questionController,
      terminal,
      uiMode: "regular",
    });

    app.start();
    try {
      running = true;
      const answer = questionController.ask({
        questions: [{
          header: "Mode",
          question: "Which mode should Bubble use?",
          options: [
            { label: "Fast", description: "Prioritize speed" },
            { label: "Careful", description: "Prioritize validation" },
          ],
        }],
      });
      const queuedAnswer = questionController.ask({
        questions: [{
          header: "Queued",
          question: "This question should open second",
          options: [{ label: "Continue", description: "Resolve from outside the panel" }],
        }],
      });
      await terminal.waitForRender();
      const viewport = terminal.getViewport().join("\n");
      expect(viewport).toContain("Which mode should Bubble use?");
      expect(viewport).not.toContain("This question should open second");
      expect(viewport).toContain("Prioritize validation");
      expect(viewport).toContain("Type your answer here");

      terminal.sendInput("\x1b[B");
      terminal.sendInput("\r");
      await expect(answer).resolves.toEqual([["Careful"]]);
      expect(cancelCalls).toBe(0);

      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("This question should open second");
      const queuedRequest = questionController.list()[0];
      expect(queuedRequest).toBeDefined();
      questionController.reply(queuedRequest!.id, [["Continue"]]);
      await expect(queuedAnswer).resolves.toEqual([["Continue"]]);

      running = false;
      terminal.sendInput("after question");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(turns).toEqual(["after question"]);

      running = true;
      const rejected = questionController.ask({
        questions: [{
          header: "Again",
          question: "Dismiss this question?",
          options: [{ label: "Keep", description: "Keep it open" }],
        }],
      });
      const rejection = expect(rejected).rejects.toBeInstanceOf(QuestionRejectedError);
      terminal.sendInput("\x1b");
      await rejection;
      expect(cancelCalls).toBe(0);
    } finally {
      app.dispose();
    }
  });

  it("shows slash suggestions and routes a selected skill invocation to the agent", async () => {
    const terminal = new VirtualTerminal(100, 24);
    const turns: string[] = [];
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      isRunning: () => false,
      getStreamingTail: () => ({ content: "", reasoning: "", tools: [], parts: [], phase: "idle" as const }),
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => false,
      runTurn: async (content: string) => { turns.push(content); },
      appendDisplayMessage: () => {},
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const skill = {
      meta: { name: "podcast", description: "Create a podcast", disableModelInvocation: false },
      source: "project",
      rootDir: "/skills/podcast",
      skillFile: "/skills/podcast/SKILL.md",
      content: "instructions",
      resources: { references: [], scripts: [], assets: [] },
    };
    const skillRegistry = {
      summaries: () => [{ name: "podcast", description: "Create a podcast", source: "project" }],
      get: (name: string) => name === "podcast" ? skill : undefined,
    };
    const app = new PiTuiApp({
      agent: {
        model: "test-model",
        providerId: "test-provider",
        thinking: "medium",
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      skillRegistry: skillRegistry as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      terminal,
      uiMode: "regular",
    });

    app.start();
    try {
      terminal.sendInput("/he");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Show available slash commands");

      terminal.sendInput("\x1b");
      terminal.sendInput("\x15");
      terminal.sendInput("/pod");
      await terminal.waitForRender();
      const viewport = terminal.getViewport().join("\n");
      expect(viewport).toContain("podcast");
      expect(viewport).toContain("[skill · project]");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(turns).toEqual([]);

      terminal.sendInput("make an episode");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toContain('load the "podcast" skill');
      expect(turns[0]).toContain("make an episode");
    } finally {
      app.dispose();
    }
  });

  it("switches /model to the composer suggestion surface without opening a centered picker", async () => {
    const terminal = new VirtualTerminal(100, 24);
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      isRunning: () => false,
      getStreamingTail: () => ({ content: "", reasoning: "", tools: [], parts: [], phase: "idle" as const }),
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => false,
      runTurn: async () => {},
      appendDisplayMessage: () => {},
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const provider = {
      id: "openai",
      name: "Test Provider",
      baseURL: "https://example.com/v1",
      apiKey: "token",
      enabled: true,
    };
    const registry = {
      getEnabled: () => [provider],
      getModelConfig: () => ({
        getCustomModels: () => [{
          id: "test-model",
          name: "Test Model",
          providerId: "openai",
          reasoningLevels: ["low", "medium", "high"],
          defaultReasoningLevel: "low",
        }],
      }),
      listModels: () => new Promise(() => {}),
    };
    const app = new PiTuiApp({
      agent: {
        model: "test-model",
        providerId: "openai",
        thinking: "medium",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      sessionManager: { getSessionFile: () => "/s.jsonl" } as never,
      controller: controller as never,
      registry: registry as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      terminal,
    });

    app.start();
    try {
      terminal.sendInput("/mod");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Switch model");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      const viewport = terminal.getViewport().join("\n");
      expect(viewport).toContain("Test Model");
      expect(viewport).toContain("Test Provider · test-model");
      expect(viewport).toContain("/model ");
      expect(viewport).toContain("⌕ ");
      expect(viewport).toContain("Search models…");
      expect(viewport).not.toContain("Select model");

      terminal.sendInput("missing");
      await terminal.waitForRender();
      const noMatchViewport = terminal.getViewport().join("\n");
      expect(noMatchViewport).toContain("No matching models");
      expect(noMatchViewport).not.toContain("Test Provider · test-model");

      terminal.sendInput("\x17");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await terminal.flush();
      expect(terminal.getViewport().join("\n")).toContain("Test Model");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      const effortViewport = terminal.getViewport().join("\n");
      expect(effortViewport).toContain("◆ ");
      expect(effortViewport).toContain("Select reasoning effort…");
      expect(effortViewport).toContain("light reasoning");
      expect(effortViewport).toContain("balanced reasoning");
      expect(effortViewport).toContain("deeper reasoning");

      terminal.sendInput("\x1b");
      await terminal.waitForRender();
      const returnedViewport = terminal.getViewport().join("\n");
      expect(returnedViewport).toContain("⌕ ");
      expect(returnedViewport).toContain("Test Model");
    } finally {
      app.dispose();
    }
  });

  it("switches /provider to the same inline searchable suggestion surface", async () => {
    const terminal = new VirtualTerminal(100, 24);
    const setDefault = vi.fn();
    const createProvider = vi.fn(() => ({ streamChat: vi.fn(), complete: vi.fn() }));
    const setProvider = vi.fn();
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        apiKey: "openai-key",
        enabled: true,
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "anthropic-key",
        enabled: true,
      },
    ];
    const updateProviderKey = vi.fn((providerId: string, key: string) => {
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (provider) provider.apiKey = key;
    });
    const appendedMessages: unknown[] = [];
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => [],
      isRunning: () => false,
      getStreamingTail: () => ({ content: "", reasoning: "", tools: [], parts: [], phase: "idle" as const }),
      pendingSteerCount: () => 0,
      queuedInputCount: () => 0,
      steer: () => false,
      cancelActiveRun: () => false,
      runTurn: async () => {},
      appendDisplayMessage: (message: unknown) => { appendedMessages.push(message); },
      clearTranscript: () => {},
      shutdown: () => ({ reason: "test", wallMs: 0 }),
    };
    const registry = {
      getEnabled: () => providers,
      getConfigured: () => providers,
      getDefault: () => providers[0],
      setDefault,
      addProvider: vi.fn((providerId: string) => {
        if (!providers.some((provider) => provider.id === providerId)) {
          providers.push({
            id: providerId,
            name: "Z.AI Coding Plan",
            baseURL: "https://api.z.ai/api/coding/paas/v4",
            apiKey: "",
            enabled: true,
          });
        }
        return true;
      }),
      updateProviderKey,
      getModelConfig: () => ({
        getCustomModels: () => [],
        hasProvider: () => false,
      }),
      listModels: async () => [],
    };
    const agent = {
      model: "openai:gpt-4o",
      providerId: "openai",
      thinking: "off",
      mode: "default",
      setMode: () => {},
      setProvider,
      getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
    };
    const app = new PiTuiApp({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}) } as never,
      controller: controller as never,
      registry: registry as never,
      createProvider: createProvider as never,
      callbacks: {
        onExitRequest: () => {},
        onClearTranscript: () => {},
        onThemeToggle: () => {},
      },
      terminal,
    });

    app.start();
    try {
      terminal.sendInput("/prov");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Manage providers");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      const viewport = terminal.getViewport().join("\n");
      expect(viewport).toContain("Search providers…");
      expect(viewport).toContain("OpenAI");
      expect(viewport).toContain("Current · openai · Configured");
      expect(viewport).toContain("Anthropic");
      expect(viewport).not.toContain("Select Provider");

      terminal.sendInput("anth");
      await terminal.waitForRender();
      const filtered = terminal.getViewport().join("\n");
      expect(filtered).toContain("Anthropic");
      expect(filtered).not.toContain("Current · openai · Configured");

      terminal.sendInput("\r");
      await vi.waitFor(() => expect(setDefault).toHaveBeenCalledWith("anthropic"));

      terminal.sendInput("/provider zai-coding-plan");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Z.AI Coding Plan");
      expect(terminal.getViewport().join("\n")).toContain("Needs API key");

      terminal.sendInput("\r");
      await terminal.waitForRender();
      const inlineKeyViewport = terminal.getViewport().join("\n");
      expect(inlineKeyViewport).toContain("◆  Enter API Key for Z.AI Coding Plan");
      expect(inlineKeyViewport).toContain("Esc or empty Backspace to return");
      expect(inlineKeyViewport).not.toContain("Paste or type the key · Enter to save · Esc to cancel");
      expect((app as unknown as { tui: { hasOverlay(): boolean } }).tui.hasOverlay()).toBe(false);

      terminal.resize(36, 12);
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Enter API Key");
      terminal.resize(100, 24);
      await terminal.waitForRender();

      terminal.sendInput("super-secret-key");
      await terminal.waitForRender();
      const keyViewport = terminal.getViewport().join("\n");
      expect(keyViewport).toContain("••••••••••••••••");
      expect(keyViewport).not.toContain("super-secret-key");

      terminal.sendInput("\x1b");
      await terminal.waitForRender();
      const escapedViewport = terminal.getViewport().join("\n");
      expect(escapedViewport).toContain("Search providers…");
      expect(escapedViewport).not.toContain("Enter API Key for Z.AI Coding Plan");
      expect(escapedViewport).not.toContain("super-secret-key");

      terminal.sendInput("zai-coding-plan");
      await terminal.waitForRender();
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Enter API Key for Z.AI Coding Plan");

      terminal.sendInput("\x7f");
      await terminal.waitForRender();
      const backedOutViewport = terminal.getViewport().join("\n");
      expect(backedOutViewport).toContain("Search providers…");
      expect(backedOutViewport).not.toContain("Enter API Key for Z.AI Coding Plan");

      terminal.sendInput("zai-coding-plan");
      await terminal.waitForRender();
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("Enter API Key for Z.AI Coding Plan");

      terminal.sendInput("super-secret-key");
      await terminal.waitForRender();
      terminal.sendInput("\r");
      await vi.waitFor(() => expect(updateProviderKey).toHaveBeenCalledWith(
        "zai-coding-plan",
        "super-secret-key",
      ));
      // Credential setup is configuration-only. The active provider/model
      // remain atomic until the user completes a /model switch.
      expect(createProvider).not.toHaveBeenCalled();
      expect(setProvider).not.toHaveBeenCalled();
      expect(agent.providerId).toBe("openai");
      expect(agent.model).toBe("openai:gpt-4o");
      expect(JSON.stringify(appendedMessages)).not.toContain("super-secret-key");
      expect(JSON.stringify((app as unknown as { history: string[] }).history)).not.toContain("super-secret-key");
      expect(terminal.getViewport().join("\n")).not.toContain("super-secret-key");
    } finally {
      app.dispose();
    }
  });
});

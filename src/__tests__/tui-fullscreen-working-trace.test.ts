import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { FullscreenApp } from "../tui/fullscreen.js";
import type { DisplayMessage } from "../tui/model/display-history.js";
import type { StreamingTailState } from "../tui/components/streaming-message.js";

describe("fullscreen working trace", () => {
  it("keeps Thinking, grouped tools, and answer live, then settles without a duplicate", async () => {
    const terminal = new VirtualTerminal(80, 20);
    const listeners: Array<() => void> = [];
    const read = {
      id: "read-1",
      name: "read",
      args: { path: "README.md" },
      status: "running" as const,
    };
    let running = true;
    let messages: DisplayMessage[] = [{ key: "user", role: "user", content: "inspect" }];
    let tail: StreamingTailState | null = {
      content: "answer",
      reasoning: "reasoning stays visible",
      tools: [read],
      parts: [{ type: "tools", toolCalls: [read] }, { type: "text", content: "answer" }],
      phase: "working",
    };
    const controller = {
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      getTranscript: () => messages,
      isRunning: () => running,
      getStreamingTail: () => tail,
      appendDisplayMessage: () => {},
      runTurn: async () => {},
    };
    const app = new FullscreenApp({
      controller: controller as never,
      agent: {
        model: "test-model",
        mode: "default",
        setMode: () => {},
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      onExit: () => {},
      onCommand: () => {},
      terminal,
    });

    app.start();
    await terminal.waitForRender();
    let viewport = terminal.getViewport().join("\n");
    expect(viewport).toContain("Thinking…");
    expect(viewport).toContain("Working on Read 1 file");
    expect(viewport).toContain("README.md");
    expect(viewport).toContain("answer");

    messages = [...messages, {
      key: "assistant",
      role: "assistant",
      content: "answer",
      reasoning: "reasoning stays visible",
      toolCalls: [{ ...read, status: "completed", result: "ok" }],
      parts: [
        { type: "tools", toolCalls: [{ ...read, status: "completed", result: "ok" }] },
        { type: "text", content: "answer" },
      ],
    }];
    tail = null;
    running = false;
    for (const listener of listeners) listener();
    await terminal.waitForRender();
    viewport = terminal.getViewport().join("\n");
    expect(viewport).toContain("Thinking");
    expect(viewport).toContain("Read 1 file");
    expect(viewport).toContain("answer");
    expect(viewport).not.toContain("Working on Read");
    expect(viewport).not.toContain("writing the response");

    app.dispose();
  });

  it("steers and cancels the active run without exiting, then unsubscribes on dispose", async () => {
    const terminal = new VirtualTerminal(80, 12);
    const steers: string[] = [];
    let cancellations = 0;
    let exits = 0;
    let unsubscribed = 0;
    const commands: string[] = [];
    const modes: string[] = [];
    let fullscreenMode = "default";
    const controller = {
      subscribe: () => () => { unsubscribed += 1; },
      getTranscript: () => [],
      isRunning: () => true,
      getStreamingTail: () => ({ content: "", reasoning: "", tools: [], parts: [], phase: "thinking" as const }),
      appendDisplayMessage: () => { throw new Error("running submit must not append a new turn row"); },
      runTurn: async () => { throw new Error("running submit must not start another run"); },
      steer: (content: string) => { steers.push(content); return true; },
      cancelActiveRun: () => { cancellations += 1; return true; },
    };
    const app = new FullscreenApp({
      controller: controller as never,
      agent: {
        model: "test-model",
        get mode() { return fullscreenMode; },
        setMode(next: string) {
          fullscreenMode = next;
          modes.push(next);
        },
        getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 1_000 }),
      } as never,
      onExit: () => { exits += 1; },
      onCommand: (command) => { commands.push(command); },
      terminal,
    });

    app.start();
    terminal.sendInput("\x1b[Z");
    await terminal.waitForRender();
    expect(modes).toEqual(["plan"]);
    expect(terminal.getViewport().join("\n")).toContain("plan on");

    terminal.resize(20, 5);
    await terminal.waitForRender();
    terminal.sendInput("/help");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(commands).toEqual(["/help"]);
    expect(steers).toEqual([]);

    terminal.sendInput("follow up");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(steers).toEqual(["follow up"]);

    terminal.sendInput("\x03");
    expect(cancellations).toBe(1);
    expect(exits).toBe(0);

    terminal.sendInput("\x1b");
    expect(cancellations).toBe(2);
    expect(exits).toBe(0);

    app.dispose();
    expect(unsubscribed).toBe(1);
  });
});

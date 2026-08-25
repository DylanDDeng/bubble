import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { FullscreenApp } from "../tui/fullscreen.js";
import type { DisplayMessage } from "../tui/model/display-history.js";
import type { StreamingTailState } from "../tui/components/streaming-message.js";

describe("fullscreen working trace", () => {
  it("renders Grok-style Compacting and Cancelling states in the shared activity lane", async () => {
    const terminal = new VirtualTerminal(64, 10);
    const listeners: Array<() => void> = [];
    let activity: { kind: "compact"; status: "running" | "cancelling"; startedAt: number } | null = {
      kind: "compact",
      status: "running",
      startedAt: Date.now(),
    };
    let messages: DisplayMessage[] = [];
    const controller = {
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      getTranscript: () => messages,
      isRunning: () => false,
      getStreamingTail: () => null,
      getCommandActivity: () => activity,
      appendDisplayMessage: () => {},
      runTurn: async () => {},
      cancelActiveRun: () => false,
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
    expect(terminal.getViewport().join("\n")).toContain("Compacting…");

    activity = { ...activity!, status: "cancelling" };
    listeners.forEach((listener) => listener());
    await terminal.waitForRender();
    expect(terminal.getViewport().join("\n")).toContain("Cancelling…");

    messages = [{
      key: "compact-done",
      role: "assistant",
      content: "Compaction cancelled.",
      syntheticKind: "ui_notice",
    }];
    activity = null;
    listeners.forEach((listener) => listener());
    await terminal.waitForRender();
    const settled = terminal.getViewport().join("\n");
    expect(settled).toContain("Compaction cancelled.");
    expect(settled).not.toContain("Cancelling…");

    app.dispose();
  });

  it("hovers and expands a completed Compact summary through real mouse events", async () => {
    const terminal = new VirtualTerminal(80, 18);
    const messages: DisplayMessage[] = [{
      key: "compact-done",
      role: "assistant",
      content: "Compaction completed in 1.2s.",
      syntheticKind: "ui_compact_summary",
      compactionSummary: "Goal: preserve authentication behavior\nNext: run the full test suite",
    }];
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => messages,
      isRunning: () => false,
      getStreamingTail: () => null,
      getCommandActivity: () => null,
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
    const click = async (row: number) => {
      const terminalRow = row + 1;
      terminal.sendInput(`\x1b[<0;2;${terminalRow}M`);
      terminal.sendInput(`\x1b[<0;2;${terminalRow}m`);
      await terminal.waitForRender();
    };

    app.start();
    await terminal.waitForRender();
    let rows = terminal.getViewport();
    let headerRow = rows.findIndex((row) => row.includes("◆ Compaction completed in 1.2s."));
    expect(headerRow).toBeGreaterThan(0);
    expect(rows.join("\n")).not.toContain("preserve authentication behavior");

    terminal.sendInput(`\x1b[<35;2;${headerRow + 1}M`);
    await terminal.waitForRender();
    rows = terminal.getViewport();
    expect(rows[headerRow - 1]?.trim()).toMatch(/^┌.*┐$/u);
    expect(rows[headerRow]?.trim()).toMatch(/^│  ◆ Compaction completed in 1\.2s\..*│$/u);
    expect(rows[headerRow + 1]?.trim()).toMatch(/^└.*┘$/u);

    await click(headerRow);
    rows = terminal.getViewport();
    expect(rows.join("\n")).toContain("› Compaction completed in 1.2s.");
    await click(headerRow);
    rows = terminal.getViewport();
    const expanded = rows.join("\n");
    expect(expanded).toContain("⌄ Compaction completed in 1.2s.");
    expect(expanded).toContain("Goal: preserve authentication behavior");
    expect(expanded).toContain("Next: run the full test suite");

    app.dispose();
  });

  it("opens settled Find Files and Execute entries through real mouse events", async () => {
    const terminal = new VirtualTerminal(80, 24);
    const glob = {
      id: "glob-1",
      name: "glob",
      args: { pattern: "src/**/*.ts" },
      result: "src/a.ts\nsrc/b.ts",
      status: "completed" as const,
      metadata: { matches: 2 },
    };
    const execute = {
      id: "execute-1",
      name: "bash",
      args: { command: "printf 'one\\ntwo\\n'", description: "print lines" },
      result: "one\ntwo",
      status: "completed" as const,
    };
    const messages: DisplayMessage[] = [{
      key: "assistant",
      role: "assistant",
      content: "",
      toolCalls: [glob, execute],
      parts: [{ type: "tools", toolCalls: [glob, execute] }],
    }];
    const controller = {
      subscribe: () => () => {},
      getTranscript: () => messages,
      isRunning: () => false,
      getStreamingTail: () => null,
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
    const click = async (row: number) => {
      const terminalRow = row + 1;
      terminal.sendInput(`\x1b[<0;2;${terminalRow}M`);
      terminal.sendInput(`\x1b[<0;2;${terminalRow}m`);
      await terminal.waitForRender();
    };

    app.start();
    await terminal.waitForRender();
    let rows = terminal.getViewport();
    let text = rows.join("\n");
    expect(text).toContain("◆ Find Files 2 files");
    expect(text).toContain("◆ Execute print lines");
    expect(text).not.toContain("src/a.ts");
    expect(text).not.toContain("printf 'one\\ntwo\\n'");

    let headerRow = rows.findIndex((row) => row.includes("◆ Find Files 2 files"));
    await click(headerRow);
    rows = terminal.getViewport();
    expect(rows.join("\n")).toContain("│  › Find Files 2 files");
    await click(headerRow);
    rows = terminal.getViewport();
    text = rows.join("\n");
    expect(text).toContain("⌄ Find Files 2 files");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");

    headerRow = rows.findIndex((row) => row.includes("◆ Execute print lines"));
    await click(headerRow);
    rows = terminal.getViewport();
    expect(rows.join("\n")).toContain("│  › Execute print lines");
    await click(headerRow);
    text = terminal.getViewport().join("\n");
    expect(text).toContain("⌄ Execute print lines");
    expect(text).toContain("printf 'one\\ntwo\\n'");
    expect(text).toContain("one");
    expect(text).toContain("two");

    app.dispose();
  });

  it("keeps Thinking, grouped tools, and answer live, then settles without a duplicate", async () => {
    const terminal = new VirtualTerminal(80, 20);
    const listeners: Array<() => void> = [];
    const read = {
      id: "read-1",
      name: "read",
      args: { path: "README.md" },
      status: "running" as const,
      result: "ok",
    };
    let running = true;
    let messages: DisplayMessage[] = [
      ...Array.from({ length: 8 }, (_, index): DisplayMessage => ({
        key: `history-${index}`,
        role: "assistant",
        content: `history-${index}`,
      })),
      { key: "user", role: "user", content: "inspect" },
    ];
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
    let viewportRows = terminal.getViewport();
    let viewport = viewportRows.join("\n");
    expect(viewport).toContain("Thinking…");
    expect(viewport).toContain("◆ Read README.md running");
    expect(viewportRows.some((row) => row.trim() === "ok")).toBe(false);
    expect(viewport).toContain("answer");
    const liveAnswer = viewportRows.find((row) => row.trim() === "answer");
    expect(liveAnswer?.indexOf("answer")).toBe(0);
    const liveComposerAt = viewportRows.findIndex((row) => row.includes("┌"));
    let liveComposerDistance = liveComposerAt - viewportRows.indexOf(liveAnswer!);
    expect(liveComposerAt).toBeGreaterThan(viewportRows.indexOf(liveAnswer!));

    // Grok parity: a single Read is one entry. Single click selects it and the
    // second click unfolds its preview in place.
    const readHeaderRow = viewportRows.findIndex((row) => row.includes("◆ Read README.md running"));
    const mouseRow = readHeaderRow + 1;
    terminal.sendInput(`\x1b[<35;2;${mouseRow}M`);
    await terminal.waitForRender();
    viewportRows = terminal.getViewport();
    expect(viewportRows[readHeaderRow - 1]?.trim()).toMatch(/^┌.*┐$/u);
    expect(viewportRows[readHeaderRow]?.trim()).toMatch(/^│  ◆ Read README\.md running.*│$/u);
    expect(viewportRows[readHeaderRow + 1]?.trim()).toMatch(/^└.*┘$/u);

    const composerRow = viewportRows.map((row) => row.includes("┌")).lastIndexOf(true);
    terminal.sendInput(`\x1b[<35;2;${composerRow + 1}M`);
    await terminal.waitForRender();
    viewportRows = terminal.getViewport();
    expect(viewportRows[readHeaderRow - 1]?.trim()).toBe("");
    expect(viewportRows[readHeaderRow]?.trim()).toBe("◆ Read README.md running");

    terminal.sendInput(`\x1b[<35;2;${mouseRow}M`);
    await terminal.waitForRender();
    terminal.sendInput(`\x1b[<0;2;${mouseRow}M`);
    terminal.sendInput(`\x1b[<0;2;${mouseRow}m`);
    await terminal.waitForRender();
    viewportRows = terminal.getViewport();
    expect(viewportRows.join("\n")).toContain("› Read README.md running");
    expect(viewportRows[readHeaderRow - 1]?.trim()).toMatch(/^┌.*┐$/u);
    expect(viewportRows[readHeaderRow]?.trim()).toMatch(/^│  › Read README\.md running.*│$/u);
    expect(viewportRows[readHeaderRow + 1]?.trim()).toMatch(/^└.*┘$/u);
    terminal.sendInput(`\x1b[<0;2;${mouseRow}M`);
    terminal.sendInput(`\x1b[<0;2;${mouseRow}m`);
    await terminal.waitForRender();
    viewportRows = terminal.getViewport();
    viewport = viewportRows.join("\n");
    expect(viewport).toContain("⌄ Read README.md running");
    expect(viewportRows.some((row) => /^│\s+ok\s+│$/u.test(row.trim()))).toBe(true);
    expect(viewportRows[readHeaderRow]).toContain("⌄ Read README.md running");
    liveComposerDistance = viewportRows.map((row) => row.includes("┌")).lastIndexOf(true)
      - viewportRows.findIndex((row) => row.trim() === "answer");

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
    viewportRows = terminal.getViewport();
    viewport = viewportRows.join("\n");
    expect(viewport).toContain("Thinking");
    expect(viewport).toContain("Read README.md");
    expect(viewport).toContain("README.md");
    expect(viewport).toContain("answer");
    expect(viewport).not.toContain("Working on Read");
    expect(viewport).not.toContain("writing the response");
    const settledAnswer = viewportRows.find((row) => row.trim() === "answer");
    expect(settledAnswer?.indexOf("answer")).toBe(liveAnswer?.indexOf("answer"));
    expect(viewport).not.toContain("● answer");
    const settledComposerAt = viewportRows.map((row) => row.includes("┌")).lastIndexOf(true);
    expect(settledComposerAt - viewportRows.indexOf(settledAnswer!)).toBe(liveComposerDistance);

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

    terminal.sendInput("\x1b[27;1;27~");
    expect(cancellations).toBe(3);
    terminal.sendInput("\x1b[27u");
    expect(cancellations).toBe(4);
    terminal.sendInput("\x1b[99;5u");
    expect(cancellations).toBe(5);
    // Releasing Escape after cancelling must not exit fullscreen.
    terminal.sendInput("\x1b[27;1:3u");
    expect(cancellations).toBe(5);
    expect(exits).toBe(0);

    app.dispose();
    expect(unsubscribed).toBe(1);
  });
});

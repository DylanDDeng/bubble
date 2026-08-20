/**
 * Headless integration test: the full controller assembled from the
 * extracted sub-modules drives a scripted session (Phase 3 exit gate).
 * Asserts snapshot sequencing, exactly-once transcript effects, and
 * clean shutdown — no terminal involved.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../types.js";
import { BubbleTuiController } from "../tui/controller/controller.js";
import type { ControllerEffect } from "../tui/controller/effects.js";
import { FakeAgent } from "../tui/testing/fake-agent.js";
import { SpyHost } from "../tui/testing/spy-host.js";

function makeController() {
  const agent = new FakeAgent();
  const host = new SpyHost();
  const effects: ControllerEffect[] = [];
  const controller = new BubbleTuiController({
    agent: agent as never,
    sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
    ports: host.ports,
    onEffect: (effect) => {
      effects.push(effect);
      host.recordEffect(effect);
    },
  });
  return { agent, host, effects, controller };
}

describe("BubbleTuiController headless session", () => {
  it("streams, commits once per turn, and finishes a run", async () => {
    const { agent, controller } = makeController();
    agent.enqueueScript({
      events: [
        { type: "turn_start" },
        { type: "text_delta", content: "Hello" },
        { type: "text_delta", content: " world" },
        { type: "reasoning_delta", content: "thinking..." },
        { type: "turn_end", usage: { promptTokens: 10, completionTokens: 5 } },
      ],
    });

    await controller.runTurn("hi", "/cwd");

    expect(controller.isRunning()).toBe(false);
    const transcript = controller.getTranscript();
    // Exactly one committed assistant message from the single turn.
    const assistantRows = transcript.filter((row) => row.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe("Hello world");
    expect(assistantRows[0]!.reasoning).toBe("thinking...");
  });

  it("commits per willContinue segment and dedups retried openings", async () => {
    const { agent, controller } = makeController();
    agent.enqueueScript({
      events: [
        { type: "text_delta", content: "part one" },
        { type: "turn_end", willContinue: true },
        // Retry discards the half-built second attempt.
        { type: "turn_start" },
        { type: "text_delta", content: "half" },
        { type: "turn_start" },
        { type: "text_delta", content: "part two" },
        { type: "turn_end" },
      ],
    });

    await controller.runTurn("go", "/cwd");
    const rows = controller.getTranscript().filter((r) => r.role === "assistant");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe("part one");
    expect(rows[1]!.content).toBe("part two");
  });

  it("subscribers observe monotonic snapshot versions across a run", async () => {
    const { agent, controller, host } = makeController();
    const versions: number[] = [];
    controller.subscribe((version) => versions.push(version));

    agent.enqueueScript({ events: [{ type: "text_delta", content: "x" }, { type: "turn_end" }] });
    await controller.runTurn("hi", "/cwd");

    expect(versions.length).toBeGreaterThan(0);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i]!).toBeGreaterThanOrEqual(versions[i - 1]!);
    }
    expect(host.effectsOf("assistant-committed")).toHaveLength(1);
  });

  it("cancelled runs surface an error effect and still settle", async () => {
    const { agent, controller, effects } = makeController();
    agent.enqueueScript({
      events: [{ type: "text_delta", content: "partial" }],
      failWith: Object.assign(new Error("aborted"), { name: "AbortError" }),
    });

    await controller.runTurn("hi", "/cwd");
    expect(effects.some((effect) => effect.kind === "run-error")).toBe(true);
    expect(controller.isRunning()).toBe(false);
    // Partial content still committed before the abort.
    expect(controller.getTranscript().some((row) => row.content === "partial")).toBe(true);
  });

  it("atomically replaces a live partial tail on error", async () => {
    const { agent, controller } = makeController();
    agent.enqueueScript({
      events: [{ type: "reasoning_delta", content: "thought" }, { type: "text_delta", content: "partial" }],
      failWith: new Error("provider failed"),
    });
    const observations: Array<{ committed: number; live: boolean }> = [];
    controller.subscribe(() => {
      observations.push({
        committed: controller.getTranscript().filter((row) => row.role === "assistant").length,
        live: controller.getStreamingTail() !== null,
      });
    });

    await controller.runTurn("go", "/cwd");

    expect(observations).toContainEqual({ committed: 1, live: false });
    expect(observations.some((snapshot) => snapshot.committed === 1 && snapshot.live)).toBe(false);
  });

  it("does not recommit a final answer when Agent cleanup fails after turn_end", async () => {
    const { agent, controller } = makeController();
    agent.enqueueScript({
      events: [{ type: "text_delta", content: "done" }, { type: "turn_end" }],
      failWith: new Error("cleanup failed"),
    });

    await controller.runTurn("go", "/cwd");

    expect(controller.getTranscript().filter((row) => row.role === "assistant" && row.content === "done")).toHaveLength(1);
    expect(controller.getTranscript()).toContainEqual(expect.objectContaining({ role: "error", content: "cleanup failed" }));
  });

  it("shutdown settles pending overlays and is idempotent", async () => {
    const { controller } = makeController();
    const first = controller.shutdown("user-quit");
    const second = controller.shutdown("user-quit");
    expect(first.reason).toBe("user-quit");
    expect(second.reason).toBe("user-quit");
    expect(first.wallMs).toBeGreaterThanOrEqual(0);
    expect(controller.pendingOverlayCount()).toBe(0);
  });

  it("surfaces the live streaming tail while a run is in flight", async () => {
    const host = new SpyHost();
    const flushes: Array<() => void> = [];
    host.ports.flush = {
      scheduleFlush: (ms, flush) => {
        expect(ms).toBe(40);
        flushes.push(flush);
      },
      cancelFlush: () => {},
    };

    let controller: BubbleTuiController | null = null;
    const gatedAgent = {
      messages: [],
      setSessionID: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "text_delta", content: "part" };
        // Fire the scheduled 40ms flush mid-run, then sample the tail.
        for (const flush of flushes) flush();
        midRunTail = controller!.getStreamingTail();
        yield { type: "turn_end" };
      },
    };
    let midRunTail: { content: string } | null = null;

    controller = new BubbleTuiController({
      agent: gatedAgent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });
    await controller.runTurn("hi", "/cwd");

    expect(flushes.length).toBeGreaterThanOrEqual(1); // scheduled by dirty deltas
    expect(midRunTail).toMatchObject({ content: "part" });
    expect(controller.getStreamingTail()).toBeNull(); // cleared at run end
  });

  it("publishes settled content and live-tail removal as one snapshot", async () => {
    const { agent, controller } = makeController();
    agent.enqueueScript({
      events: [
        { type: "reasoning_delta", content: "thinking" },
        { type: "text_delta", content: "answer" },
        { type: "turn_end" },
      ],
    });
    const observations: Array<{ committed: number; hasLiveTail: boolean }> = [];
    controller.subscribe(() => {
      observations.push({
        committed: controller.getTranscript().filter((row) => row.role === "assistant").length,
        hasLiveTail: controller.getStreamingTail() !== null,
      });
    });

    await controller.runTurn("go", "/cwd");

    expect(observations).toContainEqual({ committed: 1, hasLiveTail: false });
    expect(observations.some((item) => item.committed === 1 && item.hasLiveTail)).toBe(false);
  });

  it("keeps the empty waiting tail visible across turn_start and retry resets", async () => {
    const host = new SpyHost();
    const samples: Array<ReturnType<BubbleTuiController["getStreamingTail"]>> = [];
    let staleFlushNotifications = -1;
    let controller: BubbleTuiController;
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        samples.push(controller.getStreamingTail()); // run start / hooks
        yield { type: "turn_start" };
        samples.push(controller.getStreamingTail()); // first provider wait
        yield { type: "reasoning_delta", content: "discard me" };
        samples.push(controller.getStreamingTail());
        yield { type: "turn_start" }; // retry: cancels the pending old-attempt flush
        samples.push(controller.getStreamingTail());
        const beforeStaleFlush = notifications;
        host.fireFlush();
        staleFlushNotifications = notifications - beforeStaleFlush;
        yield { type: "reasoning_delta", content: "keep me" };
        host.fireFlush();
        yield { type: "turn_end" };
      },
    };
    controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });
    let notifications = 0;
    controller.subscribe(() => { notifications += 1; });

    await controller.runTurn("go", "/cwd");

    expect(samples.slice(0, 4).every((tail) => tail !== null)).toBe(true);
    expect(samples[0]).toMatchObject({ content: "", reasoning: "" });
    expect(samples[1]).toMatchObject({ content: "", reasoning: "" });
    expect(samples[2]).toMatchObject({ reasoning: "discard me" });
    expect(samples[3]).toMatchObject({ content: "", reasoning: "" });
    expect(staleFlushNotifications).toBe(0);
    expect(controller.getTranscript().map((row) => row.reasoning)).toEqual(["keep me"]);
  });

  it("restores a waiting tail immediately after a willContinue boundary", async () => {
    const host = new SpyHost();
    const boundaries: Array<{ committed: number; tail: ReturnType<BubbleTuiController["getStreamingTail"]> }> = [];
    let controller: BubbleTuiController;
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "tool_start", id: "t", name: "read", args: { path: "/x" } };
        yield { type: "tool_end", id: "t", name: "read", result: { content: "ok", isError: false } };
        yield { type: "turn_end", willContinue: true };
        boundaries.push({ committed: controller.getTranscript().length, tail: controller.getStreamingTail() });
        yield { type: "turn_start" };
        boundaries.push({ committed: controller.getTranscript().length, tail: controller.getStreamingTail() });
        yield { type: "text_delta", content: "done" };
        host.fireFlush();
        yield { type: "turn_end" };
      },
    };
    controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });

    await controller.runTurn("go", "/cwd");

    expect(boundaries[0]).toMatchObject({ committed: 1, tail: { content: "", reasoning: "", tools: [], parts: [], phase: "thinking" } });
    expect(boundaries[1]).toMatchObject({ committed: 1, tail: { content: "", reasoning: "", tools: [], parts: [], phase: "thinking" } });
    expect(controller.getTranscript()).toHaveLength(2);
  });

  it("restores provider-turn Thinking after a tool boundary", async () => {
    const host = new SpyHost();
    const phases: Array<ReturnType<BubbleTuiController["getStreamingTail"]>> = [];
    let controller: BubbleTuiController;
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "reasoning_delta", content: "initial plan" };
        phases.push(controller.getStreamingTail());
        yield { type: "tool_start", id: "t1", name: "read", args: { path: "/x" } };
        phases.push(controller.getStreamingTail());
        yield { type: "tool_end", id: "t1", name: "read", result: { content: "ok", isError: false } };
        yield { type: "turn_end", willContinue: true };
        yield { type: "turn_start" };
        yield { type: "reasoning_delta", content: "next internal plan" };
        phases.push(controller.getStreamingTail());
        yield { type: "turn_end" };
      },
    };
    controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });

    await controller.runTurn("go", "/cwd");

    expect(phases[0]).toMatchObject({ phase: "thinking", reasoning: "initial plan" });
    expect(phases[1]).toMatchObject({
      phase: "working",
      reasoning: "initial plan",
      tools: [{ name: "read", args: { path: "/x" }, status: "running" }],
    });
    expect(phases[2]).toMatchObject({ phase: "thinking", reasoning: "next internal plan", tools: [] });
  });

  it("publishes immutable tool snapshots across live updates", async () => {
    const host = new SpyHost();
    let controller: BubbleTuiController;
    let started: ReturnType<BubbleTuiController["getStreamingTail"]> = null;
    let ended: ReturnType<BubbleTuiController["getStreamingTail"]> = null;
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "tool_start", id: "t", name: "read", args: { path: "/x" } };
        started = controller.getStreamingTail();
        yield { type: "tool_end", id: "t", name: "read", result: { content: "ok", isError: false } };
        ended = controller.getStreamingTail();
        yield { type: "turn_end" };
      },
    };
    controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });

    await controller.runTurn("go", "/cwd");

    expect(started).toMatchObject({ tools: [{ status: "running", args: { path: "/x" } }] });
    expect(ended).toMatchObject({ tools: [{ status: "completed", result: "ok" }] });
    expect(started).not.toHaveProperty("tools.0.result");
    expect(started).toMatchObject({ tools: [{ status: "running" }] });
  });

  it("carries cross-provider-turn subagent updates into the live trace", async () => {
    const host = new SpyHost();
    let controller: BubbleTuiController;
    let updated: ReturnType<BubbleTuiController["getStreamingTail"]> = null;
    const runningMember = { subAgentId: "child-1", agentName: "worker", status: "running" };
    const completedMember = { ...runningMember, status: "completed", summary: "done" };
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "tool_start", id: "spawn-1", name: "spawn_agent", args: { description: "inspect" } };
        yield {
          type: "tool_end",
          id: "spawn-1",
          name: "spawn_agent",
          result: { content: "started", metadata: { kind: "subagent", subagents: [runningMember] } },
        };
        yield { type: "turn_end", willContinue: true };
        yield { type: "turn_start" };
        yield {
          type: "tool_update",
          id: "spawn-1",
          name: "spawn_agent",
          update: {
            type: "subagent_update",
            parentToolCallId: "spawn-1",
            runId: "run-1",
            subAgentId: "child-1",
            agentName: "worker",
            status: "completed",
            metadata: { kind: "subagent", subagents: [completedMember] },
          },
        };
        updated = controller.getStreamingTail();
        yield { type: "text_delta", content: "final" };
        host.fireFlush();
        yield { type: "turn_end" };
      },
    };
    controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });

    await controller.runTurn("go", "/cwd");

    expect(updated).toMatchObject({
      tools: [{ id: "spawn-1", status: "completed", metadata: { subagents: [{ status: "completed", summary: "done" }] } }],
      parts: [{ type: "tools", toolCalls: [{ id: "spawn-1", status: "completed" }] }],
    });
  });

  it("routes a second running submit through the active input queue instead of starting another run", async () => {
    const host = new SpyHost();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const runInputs: unknown[] = [];
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(input: unknown, _cwd: string, options: { inputController?: { drainPendingInputs(): Array<{ id: string; content: string }> } }): AsyncIterable<AgentEvent> {
        runInputs.push(input);
        yield { type: "turn_start" };
        started();
        await gate;
        for (const pending of options.inputController?.drainPendingInputs() ?? []) {
          yield { type: "input_applied", id: pending.id, content: pending.content, target: "current_turn" };
        }
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });

    const first = controller.runTurn("first", "/cwd");
    await entered;
    await controller.runTurn("second", "/cwd");

    expect(runInputs).toEqual(["first"]);
    expect(controller.pendingSteerCount()).toBe(1);
    expect(controller.getTranscript()).toContainEqual(expect.objectContaining({
      role: "user",
      content: "second",
      inputStatus: "pending_steer",
    }));

    release();
    await first;

    expect(runInputs).toEqual(["first"]);
    expect(controller.pendingSteerCount()).toBe(0);
    expect(controller.getTranscript().at(-1)).toMatchObject({ role: "user", content: "second" });
    expect(controller.getTranscript().at(-1)?.inputStatus).toBeUndefined();
  });

  it("replays a rejected steer as exactly one next turn", async () => {
    const host = new SpyHost();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const runInputs: unknown[] = [];
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(input: unknown, _cwd: string, options: { inputController?: { drainPendingInputs(): Array<{ id: string; content: string }> } }): AsyncIterable<AgentEvent> {
        runInputs.push(input);
        if (runInputs.length === 1) {
          yield { type: "turn_start" };
          started();
          await gate;
          for (const pending of options.inputController?.drainPendingInputs() ?? []) {
            yield {
              type: "input_rejected",
              id: pending.id,
              content: pending.content,
              reason: "no_continuation",
              target: "next_turn",
            };
          }
          yield { type: "turn_end" };
          return;
        }
        yield { type: "text_delta", content: "next answer" };
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });

    const first = controller.runTurn("first", "/cwd");
    await entered;
    expect(controller.steer("next")).toBe(true);
    release();
    await first;

    expect(runInputs).toEqual(["first", "next"]);
    expect(controller.queuedInputCount()).toBe(0);
    expect(controller.getTranscript().filter((row) => row.role === "user" && row.content === "next")).toHaveLength(1);
    expect(controller.getTranscript().find((row) => row.content === "next")?.inputStatus).toBeUndefined();
    expect(controller.getTranscript()).toContainEqual(expect.objectContaining({ content: "next answer" }));
  });

  it("aborts the real Agent signal, drops pending steers, and atomically settles an interrupt", async () => {
    const host = new SpyHost();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let observedSignal: AbortSignal | undefined;
    const agent = {
      messages: [],
      setSessionID: () => {},
      async *run(_input: unknown, _cwd: string, options: { abortSignal?: AbortSignal }): AsyncIterable<AgentEvent> {
        observedSignal = options.abortSignal;
        yield { type: "reasoning_delta", content: "thinking" };
        yield { type: "text_delta", content: "partial" };
        host.fireFlush();
        started();
        await new Promise<void>((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
        });
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
      ports: host.ports,
    });
    const observations: Array<{ partial: boolean; interrupted: boolean; live: boolean }> = [];
    controller.subscribe(() => {
      const transcript = controller.getTranscript();
      observations.push({
        partial: transcript.some((row) => row.content === "partial"),
        interrupted: transcript.some((row) => row.syntheticKind === "ui_interrupt"),
        live: controller.getStreamingTail() !== null,
      });
    });

    const run = controller.runTurn("first", "/cwd");
    await entered;
    expect(controller.steer("discard me")).toBe(true);
    expect(controller.cancelActiveRun()).toBe(true);
    await run;

    expect(observedSignal?.aborted).toBe(true);
    expect(controller.isRunning()).toBe(false);
    expect(controller.pendingSteerCount()).toBe(0);
    expect(controller.getTranscript().some((row) => row.content === "discard me")).toBe(false);
    expect(controller.getTranscript()).toContainEqual(expect.objectContaining({ content: "partial", reasoning: "thinking" }));
    expect(controller.getTranscript()).toContainEqual(expect.objectContaining({ syntheticKind: "ui_interrupt" }));
    expect(observations).toContainEqual({ partial: true, interrupted: true, live: false });
    expect(observations.some((item) => item.partial && item.live)).toBe(false);
  });

  it("streaming tail is null when idle", () => {
    const { controller } = makeController();
    expect(controller.getStreamingTail()).toBeNull();
  });

  it("session switch through the transaction notifies exactly once", async () => {
    const { controller, host } = makeController();
    host.ports.sessionHost.switchSession = () => ({
      manager: { getSessionFile: () => "/next.jsonl", getMetadata: () => ({}), appendMessage: () => {} },
    }) as never;
    const before = host.snapshotVersions.length;
    const outcome = controller.switchSession({ targetFile: "/next.jsonl", notice: "Switched session" });
    expect(outcome.ok).toBe(true);
    expect(host.snapshotVersions.length - before).toBeLessThanOrEqual(1);
    expect(controller.getTranscript().at(-1)).toMatchObject({
      content: "Switched session",
      syntheticKind: "ui_notice",
    });
  });
});

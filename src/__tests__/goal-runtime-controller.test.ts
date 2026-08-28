import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import type { AgentEvent } from "../types.js";
import { GoalStore, type GoalState } from "../goal/store.js";
import { GoalRuntimeController } from "../tui/controller/goal-runtime-controller.js";
import { BubbleTuiController } from "../tui/controller/controller.js";
import { SpyHost } from "../tui/testing/spy-host.js";
import { PiTuiApp } from "../tui/app.js";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: "goal-1",
    objective: "finish the task",
    status: "active",
    tokensUsed: 0,
    turnsSpent: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function session(initial: { goal?: GoalState; externalRuntime?: unknown } = {}) {
  let metadata = { ...initial };
  const setMetadata = vi.fn((next: typeof metadata) => { metadata = { ...next }; });
  return {
    getSessionFile: () => "/session.jsonl",
    getMetadata: () => metadata,
    setMetadata,
    metadata: () => metadata,
  };
}

function runtimeFixture(input: {
  persisted?: GoalState;
  externalRuntime?: unknown;
  queuedInputs?: number;
} = {}) {
  const store = new GoalStore({ now: () => 10, genId: () => "goal-new" });
  const manager = session({ goal: input.persisted, externalRuntime: input.externalRuntime });
  const messages: Array<{ role: string; content: string }> = [];
  const scheduled: Array<() => void> = [];
  const runs: Array<{ input: string; cwd: string }> = [];
  let queuedInputs = input.queuedInputs ?? 0;
  let running = false;
  const runtime = new GoalRuntimeController({
    store,
    getSessionManager: () => manager as never,
    isRunActive: () => running,
    queuedInputs: () => queuedInputs,
    isDisposed: () => false,
    startRun: (runInput, cwd) => runs.push({ input: runInput, cwd }),
    appendMessage: (role, content) => messages.push({ role, content }),
    onStateChanged: () => {},
    schedule: (callback) => scheduled.push(callback),
  });
  return {
    runtime,
    store,
    manager,
    messages,
    scheduled,
    runs,
    setQueuedInputs: (value: number) => { queuedInputs = value; },
    setRunning: (value: boolean) => { running = value; },
  };
}

describe("GoalRuntimeController", () => {
  it("restores an active persisted goal as paused without rewriting the session", () => {
    const fixture = runtimeFixture({ persisted: goal() });

    expect(fixture.store.snapshot()).toMatchObject({ id: "goal-1", status: "paused" });
    expect(fixture.manager.setMetadata).not.toHaveBeenCalled();
    expect(fixture.runtime.indicatorLine()).toContain("goal: paused");
  });

  it("sets, persists, and starts an initial hidden goal turn", () => {
    const fixture = runtimeFixture();

    fixture.runtime.handleCommand("/goal ship the release --budget 200k", "/repo");

    expect(fixture.store.snapshot()).toMatchObject({
      id: "goal-new",
      objective: "ship the release",
      status: "active",
      tokenBudget: 200_000,
    });
    expect(fixture.manager.metadata().goal).toMatchObject({ objective: "ship the release" });
    expect(fixture.messages).toContainEqual({ role: "user", content: "/goal ship the release --budget 200k" });
    expect(fixture.messages.some((message) => message.content.includes("working autonomously"))).toBe(true);
    expect(fixture.scheduled).toHaveLength(1);

    fixture.scheduled.shift()!();
    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]!.cwd).toBe("/repo");
    expect(fixture.runs[0]!.input).toContain("<bubble_internal_context kind=\"goal\">");
    expect(fixture.runs[0]!.input).toContain("ship the release");
  });

  it("accounts usage and schedules the next continuation after a goal run", () => {
    const fixture = runtimeFixture();
    fixture.runtime.handleCommand("/goal finish the task", "/repo");
    fixture.scheduled.length = 0;

    fixture.runtime.afterRun({
      goalRun: true,
      goalStatusAtStart: "active",
      cancelled: false,
      errored: false,
      usageTokens: 125,
      usageReported: true,
    }, "/repo");

    expect(fixture.store.snapshot()).toMatchObject({ tokensUsed: 125, turnsSpent: 1, status: "active" });
    expect(fixture.scheduled).toHaveLength(1);
    fixture.scheduled.shift()!();
    expect(fixture.runs.at(-1)!.input).toContain("Tokens used: 125");
  });

  it("stops after model completion and reports the final accounted usage once", () => {
    const fixture = runtimeFixture();
    fixture.runtime.handleCommand("/goal finish the task", "/repo");
    fixture.scheduled.length = 0;
    fixture.store.markComplete();

    fixture.runtime.afterRun({
      goalRun: true,
      goalStatusAtStart: "active",
      cancelled: false,
      errored: false,
      usageTokens: 80,
      usageReported: true,
    }, "/repo");

    expect(fixture.store.snapshot()).toMatchObject({ status: "complete", tokensUsed: 80, turnsSpent: 1 });
    expect(fixture.scheduled).toHaveLength(0);
    expect(fixture.messages.filter((message) => message.content.startsWith("Goal complete"))).toHaveLength(1);
  });

  it("lets queued user input preempt one boundary, then resumes after that turn", () => {
    const fixture = runtimeFixture({ queuedInputs: 1 });
    fixture.runtime.handleCommand("/goal finish the task", "/repo");
    fixture.scheduled.length = 0;

    fixture.runtime.afterRun({
      goalRun: true,
      goalStatusAtStart: "active",
      cancelled: false,
      errored: false,
      usageTokens: 10,
      usageReported: true,
    }, "/repo");
    expect(fixture.scheduled).toHaveLength(0);
    expect(fixture.store.snapshot()?.status).toBe("active");
    expect(fixture.messages.at(-1)?.content).toContain("paused for your input");

    fixture.setQueuedInputs(0);
    fixture.runtime.afterRun({
      goalRun: false,
      goalStatusAtStart: "active",
      cancelled: false,
      errored: false,
      usageTokens: 0,
      usageReported: false,
    }, "/repo");
    expect(fixture.scheduled).toHaveLength(1);
  });

  it("pauses active goals on cancellation and refuses external-runtime sessions", () => {
    const fixture = runtimeFixture();
    fixture.runtime.handleCommand("/goal finish the task", "/repo");
    fixture.scheduled.length = 0;
    fixture.runtime.afterRun({
      goalRun: true,
      goalStatusAtStart: "active",
      cancelled: true,
      errored: false,
      usageTokens: 0,
      usageReported: false,
    }, "/repo");
    expect(fixture.store.snapshot()?.status).toBe("paused");

    const external = runtimeFixture({ externalRuntime: { id: "grok" } });
    external.runtime.handleCommand("/goal should not run", "/repo");
    expect(external.store.snapshot()).toBeNull();
    expect(external.messages.at(-1)).toMatchObject({ role: "error" });
  });
});

describe("BubbleTuiController Goal integration", () => {
  it("runs initial and continuation turns through completion with aggregate usage", async () => {
    const host = new SpyHost();
    const store = new GoalStore({ now: () => 10, genId: () => "integrated-goal" });
    const manager = session();
    const inputs: string[] = [];
    let runCount = 0;
    const agent = {
      messages: [],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      async *run(input: string): AsyncIterable<AgentEvent> {
        inputs.push(input);
        runCount += 1;
        yield { type: "turn_start" };
        yield { type: "text_delta", content: `round ${runCount}` };
        if (runCount === 2) store.markComplete();
        yield { type: "turn_end", usage: { promptTokens: 10, completionTokens: runCount } };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: manager as never,
      goalStore: store,
      ports: host.ports,
    });

    controller.handleGoalCommand("/goal complete in two rounds", "/repo");

    await vi.waitFor(() => {
      expect(controller.isRunning()).toBe(false);
      expect(store.snapshot()?.status).toBe("complete");
      expect(inputs).toHaveLength(2);
    });
    expect(inputs.every((input) => input.includes("<bubble_internal_context kind=\"goal\">"))).toBe(true);
    expect(store.snapshot()).toMatchObject({ turnsSpent: 2, tokensUsed: 23 });
    expect(controller.getTranscript()).toContainEqual(expect.objectContaining({
      role: "assistant",
      content: expect.stringContaining("Goal complete"),
    }));
    expect(manager.metadata().goal).toMatchObject({ status: "complete", turnsSpent: 2, tokensUsed: 23 });
  });

  it("accepts /goal through the real Pi composer and renders its live footer state", async () => {
    const terminal = new VirtualTerminal(100, 30);
    const host = new SpyHost();
    const store = new GoalStore({ now: () => 10, genId: () => "terminal-goal" });
    const manager = session();
    const agent = {
      messages: [],
      model: "test:model",
      providerId: "test",
      thinking: "medium",
      mode: "default",
      setMode: () => {},
      getContextUsageSnapshot: () => ({ usedTokens: 0, contextWindow: 100_000 }),
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "text_delta", content: "done" };
        store.markComplete();
        yield { type: "turn_end", usage: { promptTokens: 20, completionTokens: 5 } };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: manager as never,
      goalStore: store,
      ports: host.ports,
    });
    const app = new PiTuiApp({
      agent: agent as never,
      sessionManager: manager as never,
      controller,
      callbacks: { onExitRequest: () => {}, onClearTranscript: () => {}, onThemeToggle: () => {} },
      terminal,
    });

    app.start();
    try {
      terminal.sendInput("/goal finish terminal verification");
      terminal.sendInput("\r");
      await vi.waitFor(() => expect(store.snapshot()?.status).toBe("complete"));
      await terminal.waitForRender();
      const viewport = terminal.getViewport().join("\n");
      expect(viewport).toContain("/goal finish terminal verification");
      expect(viewport).toContain("Goal complete");
      expect(viewport).toContain("goal: complete");
    } finally {
      app.dispose();
    }
  });
});

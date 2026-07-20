import { describe, expect, it, vi } from "vitest";
import { createDefaultHooks } from "../orchestrator/default-hooks.js";
import type { BeforeToolCallHookContext, TurnHookState } from "../orchestrator/hooks.js";
import { largeImplementationTaskReminder } from "../prompt/task-reminders.js";
import { builtinAgentProfiles, hasWriteWorktreeProfile } from "../agent/profiles.js";

interface FakeAgentOptions {
  spawn?: boolean;
  activeChildren?: number;
  runningWorkflow?: boolean;
  consumed?: boolean;
  todos?: Array<{ status: string }>;
}

function fakeAgent(options: FakeAgentOptions = {}) {
  return {
    largeTaskNudgeConsumed: options.consumed ?? false,
    hasToolAvailable: (name: string) => (name === "spawn_agent" ? options.spawn !== false : true),
    activeSubAgentCount: () => options.activeChildren ?? 0,
    hasRunningWorkflow: () => options.runningWorkflow ?? false,
    getTodos: () => options.todos ?? [],
  };
}

function runCheckpoint(input: {
  state?: TurnHookState;
  agent?: ReturnType<typeof fakeAgent>;
  toolName?: string;
}): { state: TurnHookState; reminders: string[]; agent: ReturnType<typeof fakeAgent> } {
  const hooks = createDefaultHooks();
  const beforeToolCall = hooks.map((h) => h.beforeToolCall).find(Boolean)!;
  const state: TurnHookState = input.state ?? {};
  const agent = input.agent ?? fakeAgent();
  const reminders: string[] = [];
  const ctx = {
    agent,
    cwd: process.cwd(),
    input: "test",
    state,
    queueReminder: (r: string) => reminders.push(r),
    flushReminders: () => {},
    toolCall: { id: "t1", name: input.toolName ?? "edit", arguments: "{}" },
    replaceToolCall: () => {},
    blockToolCall: () => {},
  } as unknown as BeforeToolCallHookContext;
  void beforeToolCall(ctx);
  return { state, reminders, agent };
}

function explored(count: number): Set<string> {
  return new Set(Array.from({ length: count }, (_, i) => `/repo/file-${i}.ts`));
}

describe("large-task delegation checkpoint", () => {
  it("fires once at the first mutation when breadth is met", () => {
    const { reminders, agent, state } = runCheckpoint({
      state: { exploredFiles: explored(8) },
    });

    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("Large-change checkpoint");
    expect(reminders[0]).toContain("read 8 files");
    expect(agent.largeTaskNudgeConsumed).toBe(true);
    expect(state.largeTaskCheckpointDone).toBe(true);
  });

  it("does not fire below the threshold (v1 regression: search paths never count)", () => {
    // exploredFiles only accumulates kind==="read" results, so a leading
    // glob with 100 matches contributes nothing — 2 reads stay 2.
    const { reminders } = runCheckpoint({ state: { exploredFiles: explored(2) } });
    expect(reminders).toHaveLength(0);
  });

  it("lowers the file threshold when a large todo plan corroborates", () => {
    const todos = Array.from({ length: 6 }, () => ({ status: "pending" }));
    const below = runCheckpoint({ state: { exploredFiles: explored(5) } });
    const withPlan = runCheckpoint({
      state: { exploredFiles: explored(5) },
      agent: fakeAgent({ todos }),
    });

    expect(below.reminders).toHaveLength(0);
    expect(withPlan.reminders).toHaveLength(1);
  });

  it("counts only pending/in_progress todos", () => {
    const todos = [
      ...Array.from({ length: 5 }, () => ({ status: "completed" })),
      { status: "pending" },
    ];
    const { reminders } = runCheckpoint({
      state: { exploredFiles: explored(5) },
      agent: fakeAgent({ todos }),
    });
    expect(reminders).toHaveLength(0);
  });

  it("suppresses on every gate", () => {
    const base = { exploredFiles: explored(10) };

    expect(runCheckpoint({ state: { ...base, taskType: "code_review" } }).reminders).toHaveLength(0);
    expect(runCheckpoint({ state: { ...base, taskType: "security_investigation" } }).reminders).toHaveLength(0);
    expect(runCheckpoint({ state: { ...base }, agent: fakeAgent({ spawn: false }) }).reminders).toHaveLength(0);
    expect(runCheckpoint({ state: { ...base }, agent: fakeAgent({ activeChildren: 1 }) }).reminders).toHaveLength(0);
    expect(runCheckpoint({ state: { ...base }, agent: fakeAgent({ runningWorkflow: true }) }).reminders).toHaveLength(0);
    expect(runCheckpoint({ state: { ...base }, agent: fakeAgent({ consumed: true }) }).reminders).toHaveLength(0);
    // debugging stays ELIGIBLE deliberately (misclassified broad work lands there).
    expect(runCheckpoint({ state: { ...base, taskType: "debugging" } }).reminders).toHaveLength(1);
  });

  it("evaluates exactly once per turn, fired or not", () => {
    const state: TurnHookState = { exploredFiles: explored(2) };
    const first = runCheckpoint({ state });
    expect(first.state.largeTaskCheckpointDone).toBe(true);

    // Evidence grows past the threshold later — no re-evaluation this turn.
    state.exploredFiles = explored(20);
    const second = runCheckpoint({ state });
    expect(second.reminders).toHaveLength(0);
  });

  it("ignores non-mutation tools", () => {
    const { state } = runCheckpoint({ state: { exploredFiles: explored(10) }, toolName: "read" });
    expect(state.largeTaskCheckpointDone).toBeUndefined();
  });
});

describe("largeImplementationTaskReminder wording", () => {
  it("carries counts, applied edits, and the worktree mechanics", () => {
    const text = largeImplementationTaskReminder({
      exploredFiles: 9,
      pendingTodos: 7,
      appliedEdits: 2,
      orchestrationRequested: false,
    });

    expect(text).toContain("read 9 files");
    expect(text).toContain("7 open todo items");
    expect(text).toContain("2 edits from your current batch will land regardless");
    expect(text).toContain("fork from the last COMMIT");
    expect(text).toContain("DISJOINT file set");
    expect(text).toContain("smallest coherent edit");
    expect(text).toContain("spawn_agent with the implementer profile");
    expect(text).toContain("delegation only adds merge risk");
  });

  it("offers only run_workflow when the orchestration reminder fired this turn", () => {
    const text = largeImplementationTaskReminder({
      exploredFiles: 9,
      pendingTodos: 0,
      appliedEdits: 0,
      orchestrationRequested: true,
    });

    expect(text).toContain("one run_workflow script");
    expect(text).not.toContain("spawn_agent with the implementer profile");
  });
});

describe("builtin implementer profile", () => {
  it("ships a write_worktree profile so the nudge's recommendation exists", () => {
    const profiles = builtinAgentProfiles();
    const implementer = profiles.find((p) => p.name === "implementer");

    expect(implementer).toBeDefined();
    expect(implementer!.mode).toBe("write_worktree");
    expect(implementer!.tools.include).toContain("edit");
    expect(implementer!.tools.include).toContain("bash");
    expect(implementer!.prompt).toContain("fork");
    expect(hasWriteWorktreeProfile(profiles)).toBe(true);
  });
});

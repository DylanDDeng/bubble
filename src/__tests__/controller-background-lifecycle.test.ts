import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessManager } from "../tasks/manager.js";
import { PromotionChannel } from "../tasks/promotion.js";
import { SessionManager } from "../session.js";
import { BubbleTuiController } from "../tui/controller/controller.js";
import { SpyHost } from "../tui/testing/spy-host.js";
import type { AgentEvent } from "../types.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Pi TUI background task lifecycle", () => {
  it("routes Ctrl+B promotion to the newest live Bash tool call", async () => {
    const channel = new PromotionChannel();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const continued = new Promise<void>((resolve) => { release = resolve; });
    const agent = {
      messages: [],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "tool_start", id: "call_bash", name: "bash", args: { command: "sleep 10" } };
        entered();
        await continued;
        yield {
          type: "tool_end",
          id: "call_bash",
          name: "bash",
          result: { content: "moved", metadata: { kind: "shell", background: true, taskId: "task_0001" } },
        };
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}) } as never,
      promotionChannel: channel,
      ports: new SpyHost().ports,
    });
    channel.register("call_bash", () => "task_0001");

    const run = controller.runTurn("go", "/tmp");
    await started;
    expect(controller.promoteActiveBash()).toBe("task_0001");
    release();
    await run;
    controller.shutdown("test");
  });

  it("persists start/finish, renders a clickable terminal row, and auto-resumes exactly once", async () => {
    const dir = join(tmpdir(), `bubble-controller-task-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    const session = new SessionManager(sessionFile);
    session.updateMetadata({ cwd: dir });
    const manager = new ProcessManager();
    const inputs: unknown[] = [];
    const agent = {
      messages: [],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(input: unknown): AsyncIterable<AgentEvent> {
        inputs.push(input);
        yield { type: "turn_start" };
        yield { type: "text_delta", content: "Background result handled." };
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: session,
      processManager: manager,
      tasksAutoResume: true,
      workspaceCwd: dir,
      ports: new SpyHost().ports,
    });

    const task = manager.startTask({
      command: "printf 'line one\\nline two\\n'",
      description: "Lifecycle probe",
      cwd: dir,
      ownerSessionId: sessionFile,
    });
    await manager.waitTasks([task.id], { timeoutMs: 3_000 });
    await waitUntil(() => inputs.length === 1 && !controller.isRunning());

    expect(String(inputs[0])).toContain("background-task");
    expect(manager.getTask(task.id)?.deliveredAt).toBeDefined();
    const lifecycle = controller.getTranscript().find((message) =>
      message.toolCalls?.some((tool) => tool.metadata?.taskLifecycle === "completed"));
    expect(lifecycle?.toolCalls?.[0]?.metadata).toMatchObject({
      taskId: task.id,
      taskLifecycle: "completed",
      outputLines: 2,
    });
    expect(controller.getTranscript()).toContainEqual(expect.objectContaining({
      content: "Background result handled.",
    }));
    const markers = session.getEntries().filter((entry) => entry.type === "marker");
    expect(markers.map((entry) => entry.kind)).toEqual(["task_started", "task_finished"]);

    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(inputs).toHaveLength(1);
    controller.shutdown("test");

    const restored = new BubbleTuiController({
      agent: { ...agent, messages: [] } as never,
      sessionManager: new SessionManager(sessionFile),
      ports: new SpyHost().ports,
    });
    const restoredLifecycle = restored.getTranscript().find((message) =>
      message.toolCalls?.some((tool) => tool.metadata?.taskId === task.id));
    expect(restoredLifecycle?.toolCalls?.[0]?.result).toContain("line two");
    expect(restoredLifecycle?.toolCalls?.[0]?.metadata).toMatchObject({
      taskLifecycle: "completed",
      outputLines: 2,
    });
    restored.shutdown("test");
  });

  it("lands a same-round completion on the launch row instead of a row after the answer", async () => {
    const dir = join(tmpdir(), `bubble-controller-task-land-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    const session = new SessionManager(sessionFile);
    session.updateMetadata({ cwd: dir });
    const manager = new ProcessManager();
    let taskId = "";
    const agent = {
      messages: [],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "tool_start", id: "call_bash", name: "bash", args: { command: "printf 'ok\\n'", run_in_background: true } };
        const task = manager.startTask({ command: "printf 'ok\\n'", description: "Probe", cwd: dir, ownerSessionId: sessionFile });
        taskId = task.id;
        yield {
          type: "tool_end",
          id: "call_bash",
          name: "bash",
          result: { content: `Started background task ${task.id}`, metadata: { kind: "shell", background: true, taskId: task.id } },
        };
        await manager.waitTasks([task.id], { timeoutMs: 3_000 });
        // Let the finish listener run before the answer commits.
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { type: "text_delta", content: "All good." };
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: session,
      processManager: manager,
      tasksAutoResume: false,
      workspaceCwd: dir,
      ports: new SpyHost().ports,
    });

    await controller.runTurn("go", dir);

    const rows = controller.getTranscript().flatMap((message) =>
      (message.toolCalls ?? []).filter((tool) => tool.metadata?.taskId === taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("call_bash");
    expect(rows[0]?.metadata).toMatchObject({ taskLifecycle: "completed", exitCode: 0, outputLines: 1 });
    expect(rows[0]?.result).toContain("ok");
    const last = controller.getTranscript().at(-1);
    expect(last?.content).toBe("All good.");
    expect(last?.toolCalls?.[0]?.id).toBe("call_bash");
    controller.shutdown("test");
  });

  it("holds a completion that beats its launch tool_end and lands it once the row settles", async () => {
    const dir = join(tmpdir(), `bubble-controller-task-race-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    const session = new SessionManager(sessionFile);
    session.updateMetadata({ cwd: dir });
    const manager = new ProcessManager();
    let taskId = "";
    const agent = {
      messages: [],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "tool_start", id: "call_bash", name: "bash", args: { command: "printf 'fast\\n'", run_in_background: true } };
        const task = manager.startTask({ command: "printf 'fast\\n'", description: "Race", cwd: dir, ownerSessionId: sessionFile });
        taskId = task.id;
        await manager.waitTasks([task.id], { timeoutMs: 3_000 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield {
          type: "tool_end",
          id: "call_bash",
          name: "bash",
          result: { content: `Started background task ${task.id}`, metadata: { kind: "shell", background: true, taskId: task.id } },
        };
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: session,
      processManager: manager,
      tasksAutoResume: false,
      workspaceCwd: dir,
      ports: new SpyHost().ports,
    });

    await controller.runTurn("go", dir);

    const rows = controller.getTranscript().flatMap((message) =>
      (message.toolCalls ?? []).filter((tool) => tool.metadata?.taskId === taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("call_bash");
    expect(rows[0]?.metadata?.taskLifecycle).toBe("completed");
    expect(rows[0]?.result).toContain("fast");
    controller.shutdown("test");
  });

  it("restores a persisted completion onto the launch row rebuilt from history", () => {
    const dir = join(tmpdir(), `bubble-controller-task-restore-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    const session = new SessionManager(sessionFile);
    session.updateMetadata({ cwd: dir });
    session.appendMarker("task_started", JSON.stringify({ id: "task_0007", startedAt: 1_000, command: "npm test" }));
    session.appendMarker("task_finished", JSON.stringify({
      id: "task_0007", status: "failed", exitCode: 1, startedAt: 1_000, endedAt: 3_000, outputLines: 4, output: "1 failed\n",
    }));
    const agent = {
      messages: [
        { role: "user", content: "run tests" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_bash", name: "bash", arguments: JSON.stringify({ command: "npm test", description: "Run tests", run_in_background: true }) }],
        },
        {
          role: "tool",
          toolCallId: "call_bash",
          content: "Started background task task_0007 (Run tests).",
          metadata: { kind: "shell", command: "npm test", taskId: "task_0007", background: true },
        },
        { role: "assistant", content: "Tests are running in the background." },
      ],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: new SessionManager(sessionFile),
      ports: new SpyHost().ports,
    });

    const transcript = controller.getTranscript();
    const rows = transcript.flatMap((message) => (message.toolCalls ?? []).filter((tool) => tool.metadata?.taskId === "task_0007"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("call_bash");
    expect(rows[0]?.isError).toBe(true);
    expect(rows[0]?.result).toContain("1 failed");
    expect(rows[0]?.startedAt).toBe(1_000);
    expect(rows[0]?.metadata).toMatchObject({ taskLifecycle: "failed", exitCode: 1, endedAt: 3_000, outputLines: 4 });
    expect(transcript.at(-1)?.content).toBe("Tests are running in the background.");
    controller.shutdown("test");
  });

  it("keeps a historic launch intact when a resumed process reuses its task id", async () => {
    const dir = join(tmpdir(), `bubble-controller-task-reuse-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    const session = new SessionManager(sessionFile);
    session.updateMetadata({ cwd: dir });
    // A previous process ran task_0001 and persisted its failure.
    session.appendMarker("task_started", JSON.stringify({ id: "task_0001", startedAt: 1_000, command: "npm test" }));
    session.appendMarker("task_finished", JSON.stringify({
      id: "task_0001", status: "failed", exitCode: 1, startedAt: 1_000, endedAt: 3_000, outputLines: 1, output: "old failure\n",
    }));
    const manager = new ProcessManager(); // fresh process: the next task is task_0001 again
    const agent = {
      messages: [
        { role: "user", content: "run tests" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_old", name: "bash", arguments: JSON.stringify({ command: "npm test", run_in_background: true }) }],
        },
        {
          role: "tool",
          toolCallId: "call_old",
          content: "Started background task task_0001.",
          metadata: { kind: "shell", command: "npm test", taskId: "task_0001", background: true },
        },
      ],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "tool_start", id: "call_new", name: "bash", args: { command: "printf 'fresh\\n'", run_in_background: true } };
        const task = manager.startTask({ command: "printf 'fresh\\n'", description: "Again", cwd: dir, ownerSessionId: sessionFile });
        expect(task.id).toBe("task_0001");
        yield {
          type: "tool_end",
          id: "call_new",
          name: "bash",
          result: { content: `Started background task ${task.id}`, metadata: { kind: "shell", background: true, taskId: task.id } },
        };
        await manager.waitTasks([task.id], { timeoutMs: 3_000 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: session,
      processManager: manager,
      tasksAutoResume: false,
      workspaceCwd: dir,
      ports: new SpyHost().ports,
    });

    const before = controller.getTranscript().flatMap((message) => message.toolCalls ?? []);
    expect(before.map((row) => [row.id, row.metadata?.taskLifecycle])).toEqual([["call_old", "failed"]]);

    await controller.runTurn("go", dir);

    const rows = controller.getTranscript().flatMap((message) => message.toolCalls ?? []);
    expect(rows.map((row) => [row.id, row.metadata?.taskLifecycle, row.result])).toEqual([
      ["call_old", "failed", "old failure\n"],
      ["call_new", "completed", expect.stringContaining("fresh")],
    ]);
    controller.shutdown("test");
  });

  it("does not land a pre-clear completion on a post-clear launch that reuses its id", () => {
    const dir = join(tmpdir(), `bubble-controller-task-orphan-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, "session.jsonl");
    const session = new SessionManager(sessionFile);
    session.updateMetadata({ cwd: dir });
    session.appendMarker("task_started", JSON.stringify({ id: "task_0001", startedAt: 1_000, command: "npm test" }));
    session.appendMarker("conversation_clear", "");
    session.appendMarker("task_finished", JSON.stringify({
      id: "task_0001", status: "failed", exitCode: 1, startedAt: 1_000, endedAt: 3_000, outputLines: 1, output: "pre-clear failure\n",
    }));
    const agent = {
      messages: [
        { role: "user", content: "again" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_new", name: "bash", arguments: JSON.stringify({ command: "npm run build", run_in_background: true }) }],
        },
        {
          role: "tool",
          toolCallId: "call_new",
          content: "Started background task task_0001.",
          metadata: { kind: "shell", command: "npm run build", taskId: "task_0001", background: true },
        },
      ],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "turn_end" };
      },
    };
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: new SessionManager(sessionFile),
      ports: new SpyHost().ports,
    });

    const rows = controller.getTranscript().flatMap((message) => message.toolCalls ?? []);
    expect(rows.find((row) => row.id === "call_new")?.metadata?.taskLifecycle).toBeUndefined();
    const detached = rows.filter((row) => row.id.startsWith("task-lifecycle:task_0001:"));
    expect(detached).toHaveLength(1);
    expect(detached[0]?.result).toContain("pre-clear failure");
    controller.shutdown("test");
  });

  it("does not duplicate a persisted completion row when switching back to its owner session", async () => {
    const dir = join(tmpdir(), `bubble-controller-task-switch-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const ownerFile = join(dir, "owner.jsonl");
    const otherFile = join(dir, "other.jsonl");
    const owner = new SessionManager(ownerFile);
    owner.updateMetadata({ cwd: dir });
    const other = new SessionManager(otherFile);
    other.updateMetadata({ cwd: dir });
    const manager = new ProcessManager();
    const agent = {
      messages: [],
      setSessionID: () => {},
      listSubAgents: () => [],
      listWorkflows: () => [],
      getSubAgentMessages: () => [],
      closeSubAgent: async () => {},
      closeWorkflow: () => {},
      resetContextUsageAnchor: () => {},
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: "turn_start" };
        yield { type: "turn_end" };
      },
    };
    const host = new SpyHost();
    host.ports.sessionHost.switchSession = (file) => ({
      manager: new SessionManager(file),
    });
    const controller = new BubbleTuiController({
      agent: agent as never,
      sessionManager: owner,
      processManager: manager,
      tasksAutoResume: false,
      workspaceCwd: dir,
      ports: host.ports,
    });

    const task = manager.startTask({
      command: "printf 'finished in owner\\n'",
      description: "Owner task",
      cwd: dir,
      ownerSessionId: ownerFile,
    });
    expect(controller.switchSession({ targetFile: otherFile }).ok).toBe(true);
    await manager.waitTasks([task.id], { timeoutMs: 3_000 });

    expect(controller.switchSession({ targetFile: ownerFile }).ok).toBe(true);
    const rows = controller.getTranscript().filter((message) =>
      message.toolCalls?.some((tool) => tool.metadata?.taskId === task.id
        && tool.metadata?.taskLifecycle === "completed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolCalls?.[0]?.result).toContain("finished in owner");
    controller.shutdown("test");
  });
});

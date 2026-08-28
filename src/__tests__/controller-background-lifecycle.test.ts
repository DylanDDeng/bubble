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

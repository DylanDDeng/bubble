import { describe, expect, it } from "vitest";
import { buildTaskLifecycleReminder } from "../agent/task-lifecycle-reminder.js";
import type { BackgroundTaskInfo } from "../tasks/manager.js";

function task(overrides: Partial<BackgroundTaskInfo>): BackgroundTaskInfo {
  return {
    kind: "task",
    id: "task_0001",
    command: "npm test",
    cwd: "/tmp",
    status: "running",
    startedAt: Date.now() - 5000,
    outputTruncated: false,
    ...overrides,
  };
}

describe("buildTaskLifecycleReminder", () => {
  it("returns undefined with no tasks", () => {
    expect(buildTaskLifecycleReminder({ tasks: [], outputTail: () => undefined })).toBeUndefined();
  });

  it("lists running tasks with elapsed time and the tool contract", () => {
    const reminder = buildTaskLifecycleReminder({
      tasks: [task({ description: "run tests" })],
      outputTail: () => undefined,
    })!;

    expect(reminder).toContain("Background task truth:");
    expect(reminder).toMatch(/running: task_0001 \(run tests, \d+s elapsed\)/);
    expect(reminder).toContain("never poll with foreground sleep");
  });

  it("carries an output tail for finished-undelivered tasks", () => {
    const reminder = buildTaskLifecycleReminder({
      tasks: [task({ status: "completed", exitCode: 0, endedAt: Date.now() })],
      outputTail: () => "230 tests passed\n",
    })!;

    expect(reminder).toContain("finished since last update: task_0001");
    expect(reminder).toContain("230 tests passed");
    expect(reminder).toContain("Call task_output only if you need more");
  });

  it("drops the tool_search hint once the task tools are unlocked", () => {
    const withTools = buildTaskLifecycleReminder({
      tasks: [task({})],
      outputTail: () => undefined,
      toolsAvailable: true,
    })!;
    const withoutTools = buildTaskLifecycleReminder({
      tasks: [task({})],
      outputTail: () => undefined,
    })!;

    expect(withTools).toContain("do NOT call tool_search");
    expect(withTools).not.toContain("load via tool_search");
    expect(withoutTools).toContain("load via tool_search");
  });

  it("demotes delivered tasks to id and status without output", () => {
    const reminder = buildTaskLifecycleReminder({
      tasks: [task({ status: "completed", exitCode: 0, endedAt: Date.now(), deliveredAt: Date.now() })],
      outputTail: () => "should not appear",
    })!;

    expect(reminder).toContain("delivered: task_0001 completed (exit 0)");
    expect(reminder).not.toContain("should not appear");
  });
});

describe("Agent.consumeBackgroundTaskReminder state-change gate", () => {
  it("emits only when the manager version changes", async () => {
    const { Agent } = await import("../agent.js");
    const agent = Object.create(Agent.prototype) as InstanceType<typeof Agent>;
    (agent as any).lastTaskReminderVersion = -1;

    let version = 1;
    const tasks: BackgroundTaskInfo[] = [task({})];
    agent.backgroundTasks = {
      list: () => tasks,
      version: () => version,
      outputTail: () => undefined,
    };

    expect(agent.consumeBackgroundTaskReminder()).toContain("Background task truth");
    // Same version: gated.
    expect(agent.consumeBackgroundTaskReminder()).toBeUndefined();
    // State change: emits again.
    version = 2;
    expect(agent.consumeBackgroundTaskReminder()).toContain("Background task truth");
  });

  it("returns undefined when no bridge is wired", async () => {
    const { Agent } = await import("../agent.js");
    const agent = Object.create(Agent.prototype) as InstanceType<typeof Agent>;
    (agent as any).lastTaskReminderVersion = -1;
    expect(agent.consumeBackgroundTaskReminder()).toBeUndefined();
  });
});

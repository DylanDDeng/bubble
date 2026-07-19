import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../tasks/manager.js";
import { createBashTool } from "../tools/bash.js";
import { createBackgroundTaskTools } from "../tools/task-tools.js";
import type { ApprovalRequest } from "../approval/types.js";

const cwd = join(tmpdir(), `bubble-task-tools-${process.pid}`);
mkdirSync(cwd, { recursive: true });

function tools(manager: ProcessManager) {
  const [taskOutput, killTask] = createBackgroundTaskTools(manager);
  return { taskOutput: taskOutput!, killTask: killTask! };
}

describe("bash run_in_background", () => {
  it("starts a task, unlocks the deferred tools, and returns immediately", async () => {
    const manager = new ProcessManager();
    const unlock = vi.fn();
    const bash = createBashTool(cwd, undefined, undefined, {
      processManager: manager,
      allowBackgroundTasks: true,
    });

    const result = await bash.execute(
      { command: "echo bg && exit 0", run_in_background: true, description: "test task" },
      { cwd, sessionID: "sess-1", agent: { unlockDeferredTools: unlock } } as any,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/Started background task task_\d{4}/);
    expect(unlock).toHaveBeenCalledWith(["task_output", "kill_task"]);
    const taskId = (result.metadata as any).taskId as string;
    expect(manager.getTask(taskId)!.ownerSessionId).toBe("sess-1");
    await manager.waitTasks([taskId], { timeoutMs: 5000 });
  });

  it("passes background:true to the approval request", async () => {
    const manager = new ProcessManager();
    const requests: ApprovalRequest[] = [];
    const bash = createBashTool(cwd, {
      checkRules: () => ({ decision: "ask" as const }),
      request: async (request: ApprovalRequest) => {
        requests.push(request);
        return { action: "approve" as const };
      },
    }, undefined, { processManager: manager, allowBackgroundTasks: true });

    const result = await bash.execute(
      { command: "exit 0", run_in_background: true },
      { cwd, sessionID: "sess-1" } as any,
    );
    expect(result.isError).toBeUndefined();
    expect(requests[0]).toMatchObject({ type: "bash", background: true });
    await manager.waitTasks([(result.metadata as any).taskId], { timeoutMs: 5000 });
  });

  it("rejects run_in_background when the host capability is off", async () => {
    const bash = createBashTool(cwd);
    const result = await bash.execute(
      { command: "echo hi", run_in_background: true },
      { cwd } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("run_in_background is unavailable");
  });

  it("does not advertise the parameter when the capability is off", () => {
    const off = createBashTool(cwd);
    const on = createBashTool(cwd, undefined, undefined, {
      processManager: new ProcessManager(),
      allowBackgroundTasks: true,
    });
    expect((off.parameters as any).properties.run_in_background).toBeUndefined();
    expect((on.parameters as any).properties.run_in_background).toBeDefined();
  });
});

describe("task_output", () => {
  it("returns an immediate snapshot without wait_ms", async () => {
    const manager = new ProcessManager();
    const { taskOutput } = tools(manager);
    const task = manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s" });

    const result = await taskOutput.execute({ task_ids: [task.id] }, { cwd } as any);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`${task.id}: running`);
    manager.reapTasksSync();
  });

  it("waits for completion with wait_ms and marks delivered", async () => {
    const manager = new ProcessManager();
    const { taskOutput } = tools(manager);
    const task = manager.startTask({ command: "echo done-marker && exit 0", cwd, ownerSessionId: "s" });

    const result = await taskOutput.execute(
      { task_ids: [task.id], wait_ms: 5000 },
      { cwd } as any,
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain("completed (exit 0)");
    expect(result.content).toContain("done-marker");
    expect(manager.getTask(task.id)!.deliveredAt).toBeDefined();
  });

  it("treats a wait timeout as guidance, not an error", async () => {
    const manager = new ProcessManager();
    const { taskOutput } = tools(manager);
    const task = manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s" });

    const result = await taskOutput.execute(
      { task_ids: [task.id], wait_ms: 200 },
      { cwd } as any,
    );
    expect(result.isError).toBeUndefined();
    expect(result.status).toBe("timeout");
    expect(result.content).toContain("call task_output again with a longer wait_ms");
    manager.reapTasksSync();
  });

  it("rejects unknown ids and oversized batches", async () => {
    const manager = new ProcessManager();
    const { taskOutput } = tools(manager);

    const unknown = await taskOutput.execute({ task_ids: ["task_9999"] }, { cwd } as any);
    expect(unknown.isError).toBe(true);

    const tooMany = await taskOutput.execute(
      { task_ids: Array.from({ length: 21 }, (_, i) => `task_${i}`) },
      { cwd } as any,
    );
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content).toContain("at most 20");
  });
});

describe("kill_task", () => {
  it("kills a running task and reports already-finished ones gracefully", async () => {
    const manager = new ProcessManager();
    const { killTask } = tools(manager);
    const task = manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s" });

    const killed = await killTask.execute({ task_id: task.id }, { cwd } as any);
    expect(killed.content).toContain(`Killed background task ${task.id}`);
    expect(manager.getTask(task.id)!.status).toBe("killed");

    const again = await killTask.execute({ task_id: task.id }, { cwd } as any);
    expect(again.isError).toBeUndefined();
    expect(again.content).toContain("already finished");
  });
});

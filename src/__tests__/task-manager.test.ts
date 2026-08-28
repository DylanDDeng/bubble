import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessManager } from "../tasks/manager.js";

const cwd = join(tmpdir(), `bubble-task-manager-${process.pid}`);
mkdirSync(cwd, { recursive: true });

function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("ProcessManager background tasks", () => {
  it("runs a task to completion and captures output + exit code", async () => {
    const manager = new ProcessManager();
    const task = manager.startTask({ command: "echo hello-task && exit 0", cwd, ownerSessionId: "s1" });

    expect(task.id).toMatch(/^task_\d{4}$/);
    expect(task.status).toBe("running");

    const [done] = await manager.waitTasks([task.id], { timeoutMs: 5000 });
    expect(done!.status).toBe("completed");
    expect(done!.exitCode).toBe(0);
    expect(manager.taskOutputTail(task.id)).toContain("hello-task");
  });

  it("marks non-zero exits as failed and emits onTaskFinished once", async () => {
    const manager = new ProcessManager();
    const finished: string[] = [];
    manager.onTaskFinished((task) => finished.push(`${task.id}:${task.status}`));

    const task = manager.startTask({ command: "exit 3", cwd, ownerSessionId: "s1" });
    await manager.waitTasks([task.id], { timeoutMs: 5000 });

    expect(manager.getTask(task.id)!.status).toBe("failed");
    expect(manager.getTask(task.id)!.exitCode).toBe(3);
    await waitUntil(() => finished.length === 1);
    expect(finished).toEqual([`${task.id}:failed`]);
  });

  it("kills a running task and reports killed status without a finish→failed double event", async () => {
    const manager = new ProcessManager();
    const events: string[] = [];
    manager.onTaskFinished((task) => events.push(task.status));

    const task = manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s1" });
    const killed = await manager.killTask(task.id);

    expect(killed!.status).toBe("killed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual(["killed"]);
  });

  it("enforces the per-session running cap atomically", () => {
    const manager = new ProcessManager();
    for (let i = 0; i < 8; i++) {
      manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s1" });
    }
    expect(() => manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s1" }))
      .toThrow(/Background task limit reached/);
    // A different session is not affected by s1's cap.
    const other = manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s2" });
    expect(other.status).toBe("running");
    manager.reapTasksSync();
  });

  it("waitTasks mode=all waits for every id; timeout is not an error", async () => {
    const manager = new ProcessManager();
    const quick = manager.startTask({ command: "exit 0", cwd, ownerSessionId: "s1" });
    const slow = manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "s1" });

    const anyResult = await manager.waitTasks([quick.id, slow.id], { timeoutMs: 5000, mode: "any" });
    expect(anyResult.find((t) => t.id === quick.id)!.status).toBe("completed");

    const allResult = await manager.waitTasks([quick.id, slow.id], { timeoutMs: 300, mode: "all" });
    expect(allResult.find((t) => t.id === slow.id)!.status).toBe("running");
    manager.reapTasksSync();
  });

  it("filters listTasks by owner session", () => {
    const manager = new ProcessManager();
    manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "sA" });
    manager.startTask({ command: "sleep 30", cwd, ownerSessionId: "sB" });

    expect(manager.listTasks("sA")).toHaveLength(1);
    expect(manager.listTasks()).toHaveLength(2);
    manager.reapTasksSync();
  });

  it("bumps the task state version on start, finish, and kill", async () => {
    const manager = new ProcessManager();
    const v0 = manager.getTaskStateVersion();
    const task = manager.startTask({ command: "exit 0", cwd, ownerSessionId: "s1" });
    expect(manager.getTaskStateVersion()).toBeGreaterThan(v0);
    const afterStart = manager.getTaskStateVersion();
    await manager.waitTasks([task.id], { timeoutMs: 5000 });
    expect(manager.getTaskStateVersion()).toBeGreaterThan(afterStart);
  });

  it("strips ANSI escape codes from the output tail", async () => {
    const manager = new ProcessManager();
    const task = manager.startTask({
      command: String.raw`printf '\033[32mgreen-ok\033[0m plain\n'`,
      cwd,
      ownerSessionId: "s1",
    });
    await manager.waitTasks([task.id], { timeoutMs: 5000 });

    const tail = manager.taskOutputTail(task.id)!;
    expect(tail).toContain("green-ok plain");
    expect(tail).not.toContain("[");
  });

  it("markTaskDelivered suppresses duplicate delivery but retains inspectable output", async () => {
    const manager = new ProcessManager();
    const task = manager.startTask({ command: "echo will-be-dropped", cwd, ownerSessionId: "s1" });
    await manager.waitTasks([task.id], { timeoutMs: 5000 });

    manager.markTaskDelivered(task.id);
    expect(manager.getTask(task.id)!.deliveredAt).toBeDefined();
    expect(manager.taskOutputTail(task.id)).toContain("will-be-dropped");
    expect(manager.getTask(task.id)!.exitCode).toBe(0);
  });

  it("tracks total output lines independently from the retained output tail", async () => {
    const manager = new ProcessManager();
    const task = manager.startTask({
      command: "printf 'one\\ntwo\\nthree'",
      cwd,
      ownerSessionId: "s1",
    });
    await manager.waitTasks([task.id], { timeoutMs: 5000 });

    expect(manager.getTask(task.id)!.outputLines).toBe(3);
  });

  it("evicts oldest delivered finished tasks past the retention cap", async () => {
    const manager = new ProcessManager();
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const task = manager.startTask({ command: "exit 0", cwd, ownerSessionId: "s1" });
      ids.push(task.id);
      await manager.waitTasks([task.id], { timeoutMs: 5000 });
      manager.markTaskDelivered(task.id);
    }
    expect(manager.getTask(ids[0]!)).toBeUndefined();
    expect(manager.getTask(ids[20]!)).toBeDefined();
  });

  it("adopts an externally spawned child (Ctrl+B promotion path)", async () => {
    const { spawn } = await import("node:child_process");
    const manager = new ProcessManager();
    const child = spawn("bash", ["-c", "echo adopted && exit 0"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const task = manager.adoptTask({
      command: "echo adopted",
      cwd,
      ownerSessionId: "s1",
      child,
      outputSoFar: "pre-promotion output\n",
    });

    const [done] = await manager.waitTasks([task.id], { timeoutMs: 5000 });
    expect(done!.status).toBe("completed");
    expect(manager.taskOutputTail(task.id)).toContain("pre-promotion output");
  });
});

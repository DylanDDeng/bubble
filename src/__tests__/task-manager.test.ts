import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // Deterministic stand-in for a child whose "exit" outruns its stdio pipes.
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  }

  describe("finalization waits for stdio to drain", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not finish on exit until output buffered in the pipe has been appended", () => {
      const manager = new ProcessManager();
      const child = fakeChild();
      const finished: Array<{ status: string; tail?: string; lines: number }> = [];
      manager.onTaskFinished((t) => finished.push({
        status: t.status,
        tail: manager.taskOutputTail(t.id),
        lines: t.outputLines,
      }));
      const task = manager.adoptTask({ command: "fast", cwd, child: child as unknown as ChildProcess });

      child.emit("exit", 0, null);
      expect(manager.getTask(task.id)!.status).toBe("running");
      expect(finished).toHaveLength(0);

      child.stdout.emit("data", Buffer.from("late line 1\nlate line 2\n"));
      child.emit("close", 0, null);

      expect(finished).toEqual([{ status: "completed", tail: "late line 1\nlate line 2\n", lines: 2 }]);
      expect(manager.getTask(task.id)!.exitCode).toBe(0);
    });

    it("falls back to a bounded grace timer when close never fires (pipe held by a grandchild)", () => {
      vi.useFakeTimers();
      const manager = new ProcessManager();
      const child = fakeChild();
      const finished: string[] = [];
      manager.onTaskFinished((t) => finished.push(t.status));
      const task = manager.adoptTask({ command: "some-server &", cwd, child: child as unknown as ChildProcess });

      child.emit("exit", 3, null);
      expect(manager.getTask(task.id)!.status).toBe("running");

      vi.advanceTimersByTime(1000);
      expect(manager.getTask(task.id)!.status).toBe("failed");
      expect(manager.getTask(task.id)!.exitCode).toBe(3);

      // A late close must not emit a second finish event.
      child.emit("close", 3, null);
      expect(finished).toEqual(["failed"]);
    });

    // Real pipes: the shell exits at once and a grandchild writes ~50ms later, so
    // the output is guaranteed to reach the pipe AFTER "exit" (the CI ordering).
    const lateWriter = "(sleep 0.05; printf 'a\\nb\\nc\\n') & exit 0";

    it.skipIf(process.platform === "win32")("captures output written to the pipe after exit", async () => {
      const manager = new ProcessManager();
      const task = manager.startTask({ command: lateWriter, cwd });
      const [done] = await manager.waitTasks([task.id], { timeoutMs: 5000 });
      expect(done!.status).toBe("completed");
      expect(manager.taskOutputTail(task.id)).toBe("a\nb\nc\n");
      expect(done!.outputLines).toBe(3);
    });

    it.skipIf(process.platform === "win32")(
      "reads pending output before settling when the event loop stalls past the grace period",
      async () => {
        const { spawn } = await import("node:child_process");
        const manager = new ProcessManager();
        const child = spawn("bash", ["-c", lateWriter], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        const task = manager.adoptTask({ command: lateWriter, cwd, child });
        // Registered after the manager's exit handler: the grace timer is armed,
        // then the loop blocks until it is overdue with the output still unread.
        child.once("exit", () => {
          const end = Date.now() + 300;
          while (Date.now() < end) { /* block the event loop */ }
        });
        const [done] = await manager.waitTasks([task.id], { timeoutMs: 5000 });
        expect(done!.status).toBe("completed");
        expect(manager.taskOutputTail(task.id)).toBe("a\nb\nc\n");
      },
    );

    it.skipIf(process.platform === "win32")("does not hang when a grandchild keeps the pipes open", async () => {
      const manager = new ProcessManager();
      const startedAt = Date.now();
      const task = manager.startTask({ command: "echo started; sleep 30 & exit 0", cwd });
      const [done] = await manager.waitTasks([task.id], { timeoutMs: 5000 });
      expect(done!.status).toBe("completed");
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(manager.taskOutputTail(task.id)).toBe("started\n");
      if (done!.pid) process.kill(-done!.pid, "SIGKILL");
    });

    it("killTask during the drain window keeps the real exit and still waits for pending output", async () => {
      const manager = new ProcessManager();
      const child = fakeChild();
      const finished: Array<{ status: string; tail?: string }> = [];
      manager.onTaskFinished((t) => finished.push({ status: t.status, tail: manager.taskOutputTail(t.id) }));
      const task = manager.adoptTask({ command: "fast", cwd, child: child as unknown as ChildProcess });

      child.emit("exit", 0, null);
      const killing = manager.killTask(task.id);
      // The terminal marker snapshots the tail inside the finish event, so it
      // must not fire before the output still in the pipe has been appended.
      expect(finished).toHaveLength(0);

      child.stdout.emit("data", Buffer.from("late\n"));
      child.emit("close", 0, null);

      const result = await killing;
      expect(result!.status).toBe("completed");
      expect(result!.exitCode).toBe(0);
      expect(finished).toEqual([{ status: "completed", tail: "late\n" }]);
    });
  });
});

/**
 * Task runtime controller tests (controller extraction §5).
 * Legacy reference: app.tsx:2220-2350 (owner sessions, held completions,
 * wake coalescing with fire-time gates).
 */
import { describe, expect, it, vi } from "vitest";
import { TaskRuntimeController, type TaskRuntimeDeps } from "../tui/controller/task-runtime-controller.js";
import type { BackgroundTaskInfo } from "../tasks/manager.js";

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: "task-1",
    pid: 123,
    status: "completed",
    command: "npm test",
    description: "tests",
    startedAt: 1_000,
    endedAt: 2_000,
    ownerSessionId: "/current.jsonl",
    ...overrides,
  } as BackgroundTaskInfo;
}

function makeDeps(overrides: Partial<TaskRuntimeDeps> = {}) {
  const markers: Array<{ file: string; marker: string; payload: string }> = [];
  const announcements: BackgroundTaskInfo[] = [];
  const wakes: string[] = [];
  const listeners = { change: [] as Array<(t: BackgroundTaskInfo) => void>, finish: [] as Array<(t: BackgroundTaskInfo) => void> };
  const deps: TaskRuntimeDeps = {
    processManager: {
      listTasks: () => [],
      onChange: (listener) => {
        listeners.change.push(listener);
        return () => {};
      },
      onTaskFinished: (listener) => {
        listeners.finish.push(listener);
        return () => {};
      },
      taskOutputTail: () => "output-tail",
      markTaskDelivered: vi.fn(),
    },
    getSessionFile: () => "/current.jsonl",
    appendMarker: (file, marker, payload) => {
      markers.push({ file, marker, payload });
    },
    announceCompletion: (t) => {
      announcements.push(t);
    },
    submitTaskWake: (summary) => {
      wakes.push(summary);
    },
    tasksAutoResume: true,
    gates: () => ({ turnRunning: false, queuedInputs: 0, exiting: false }),
    wakeDebounceMs: 0,
    ...overrides,
  };
  return { deps, markers, announcements, wakes, listeners };
}

describe("task runtime controller", () => {
  it("captures owner session markers on first running change", () => {
    const h = makeDeps();
    const controller = new TaskRuntimeController(h.deps);
    controller.start();

    h.listeners.change[0]!(task({ status: "running" }));
    expect(h.markers).toHaveLength(1);
    expect(h.markers[0]).toMatchObject({ file: "/current.jsonl", marker: "task_started" });

    // Second change event for the same task does not duplicate the marker.
    h.listeners.change[0]!(task({ status: "running" }));
    expect(h.markers).toHaveLength(1);
    controller.dispose();
  });

  it("announces and wakes for a current-session completion", async () => {
    const h = makeDeps();
    const controller = new TaskRuntimeController(h.deps);
    controller.start();
    h.listeners.change[0]!(task({ status: "running" }));

    h.listeners.finish[0]!(task());
    expect(h.announcements).toHaveLength(1);
    expect(h.markers[1]).toMatchObject({ marker: "task_finished" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.wakes).toHaveLength(1);
    controller.dispose();
  });

  it("holds completions for other sessions and replays them on switch-back", async () => {
    const h = makeDeps();
    const controller = new TaskRuntimeController(h.deps);
    controller.start();

    h.listeners.finish[0]!(task({ ownerSessionId: "/other.jsonl" }));
    expect(h.announcements).toHaveLength(0);

    const replayed = controller.releaseHeldCompletions("/other.jsonl");
    expect(replayed).toHaveLength(1);
    expect(h.announcements).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.wakes).toHaveLength(1);
    controller.dispose();
  });

  it("suppresses the wake when a turn is running at fire time", async () => {
    const h = makeDeps({ gates: () => ({ turnRunning: true, queuedInputs: 0, exiting: false }) });
    const controller = new TaskRuntimeController(h.deps);
    controller.start();

    h.listeners.finish[0]!(task());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.announcements).toHaveLength(1);
    expect(h.wakes).toHaveLength(0);
    controller.dispose();
  });

  it("disposed controller fires no wake even if a task lands late", async () => {
    const h = makeDeps();
    const controller = new TaskRuntimeController(h.deps);
    controller.start();
    controller.dispose();

    // A completion racing with dispose reaches the finish listener after
    // unsubscribe; even if the coalescer had it queued, fire is suppressed.
    h.listeners.finish.forEach((listener) => listener(task()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.wakes).toHaveLength(0);
  });
});

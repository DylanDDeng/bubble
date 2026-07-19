import { describe, expect, it, vi } from "vitest";
import {
  TaskWakeCoalescer,
  findDanglingTaskStarts,
  formatTaskWakeSummary,
  shouldFireTaskWake,
  taskEligibleForWake,
} from "../tasks/wake.js";
import type { BackgroundTaskInfo } from "../tasks/manager.js";

function task(overrides: Partial<BackgroundTaskInfo>): BackgroundTaskInfo {
  return {
    kind: "task",
    id: "task_0001",
    command: "npm test",
    cwd: "/tmp",
    status: "completed",
    exitCode: 0,
    startedAt: Date.now() - 90_000,
    endedAt: Date.now(),
    outputTruncated: false,
    ...overrides,
  };
}

describe("shouldFireTaskWake", () => {
  it("fires only when idle, unqueued, enabled, and not exiting", () => {
    const base = { autoResume: true, turnRunning: false, queuedInputs: 0 };
    expect(shouldFireTaskWake(base)).toBe(true);
    expect(shouldFireTaskWake({ ...base, autoResume: false })).toBe(false);
    expect(shouldFireTaskWake({ ...base, turnRunning: true })).toBe(false);
    expect(shouldFireTaskWake({ ...base, queuedInputs: 1 })).toBe(false);
    expect(shouldFireTaskWake({ ...base, exiting: true })).toBe(false);
  });
});

describe("taskEligibleForWake", () => {
  it("wakes on completed/failed, never on killed", () => {
    expect(taskEligibleForWake(task({ status: "completed" }))).toBe(true);
    expect(taskEligibleForWake(task({ status: "failed" }))).toBe(true);
    expect(taskEligibleForWake(task({ status: "killed" }))).toBe(false);
    expect(taskEligibleForWake(task({ status: "running" }))).toBe(false);
  });
});

describe("TaskWakeCoalescer", () => {
  it("folds completions within the debounce window into one wake", async () => {
    vi.useFakeTimers();
    try {
      const fire = vi.fn();
      const coalescer = new TaskWakeCoalescer(2000, fire);
      coalescer.add(task({ id: "task_0001" }));
      vi.advanceTimersByTime(1000);
      coalescer.add(task({ id: "task_0002" }));
      vi.advanceTimersByTime(1000);

      expect(fire).toHaveBeenCalledTimes(1);
      expect(fire.mock.calls[0]![0].map((t: BackgroundTaskInfo) => t.id)).toEqual(["task_0001", "task_0002"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel drops the armed wake and returns pending tasks", () => {
    vi.useFakeTimers();
    try {
      const fire = vi.fn();
      const coalescer = new TaskWakeCoalescer(2000, fire);
      coalescer.add(task({ id: "task_0001" }));
      const dropped = coalescer.cancel();
      vi.advanceTimersByTime(5000);

      expect(fire).not.toHaveBeenCalled();
      expect(dropped.map((t) => t.id)).toEqual(["task_0001"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatTaskWakeSummary", () => {
  it("summarizes tasks with status, elapsed, and output tail", () => {
    const summary = formatTaskWakeSummary(
      [task({ description: "run tests", exitCode: 1, status: "failed" })],
      () => "3 tests failed\n",
    );
    expect(summary).toContain("task_0001 (run tests): failed exit 1 in 90s");
    expect(summary).toContain("3 tests failed");
    expect(summary).toContain("Never re-run what already finished");
    // Field-test lesson: without an explicit stop clause the model invents
    // follow-up work when nothing depends on the results.
    expect(summary).toContain("If nothing does, report the outcome to the user");
    expect(summary).toContain("do not invent new work");
  });
});

describe("findDanglingTaskStarts", () => {
  it("returns started tasks with no finish/kill marker", () => {
    const entries = [
      { type: "marker", kind: "task_started", value: JSON.stringify({ id: "task_0001", pid: 111 }) },
      { type: "marker", kind: "task_started", value: JSON.stringify({ id: "task_0002", pid: 222 }) },
      { type: "marker", kind: "task_finished", value: JSON.stringify({ id: "task_0001" }) },
      { type: "marker", kind: "model_switch", value: "openai:gpt-5.5" },
      { type: "message" },
    ];
    const dangling = findDanglingTaskStarts(entries);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toMatchObject({ id: "task_0002", pid: 222 });
  });

  it("tolerates malformed marker values", () => {
    const entries = [
      { type: "marker", kind: "task_started", value: "not-json" },
      { type: "marker", kind: "task_killed", value: JSON.stringify({ id: "task_0009" }) },
    ];
    expect(findDanglingTaskStarts(entries)).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import type { BackgroundTaskInfo } from "../tasks/manager.js";
import type { DisplayMessage, DisplayToolCall } from "../tui/model/display-history.js";
import {
  applyTaskLifecycleToMessages,
  landTaskLifecycles,
  mergeTaskLifecycleIntoLiveTools,
} from "../tui/model/task-lifecycle.js";
import { buildTraceGroups } from "../tui/model/trace-groups.js";

function finished(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    kind: "task",
    id: "task_0002",
    command: "npm --prefix astro run verify",
    description: "Run site verification",
    cwd: "/repo",
    status: "failed",
    exitCode: 1,
    startedAt: 10_000,
    endedAt: 27_000,
    outputTruncated: false,
    outputLines: 89,
    ...overrides,
  };
}

function launchRow(id = "call_bash"): DisplayToolCall {
  return {
    id,
    name: "bash",
    args: { command: "npm --prefix astro run verify", description: "Run site verification", run_in_background: true },
    status: "completed",
    result: "Started background task task_0002 (Run site verification).",
    metadata: { kind: "shell", command: "npm --prefix astro run verify", taskId: "task_0002", background: true },
    startedAt: 9_990,
  };
}

function transcriptWith(tool: DisplayToolCall): DisplayMessage[] {
  return [
    { key: "u1", role: "user", content: "review" },
    { key: "a1", role: "assistant", content: "", toolCalls: [tool], parts: [{ type: "tools", toolCalls: [tool] }] },
    { key: "a2", role: "assistant", content: "Review complete." },
  ];
}

describe("background task lifecycle landing", () => {
  it("lands the terminal state on the committed launch row instead of appending", () => {
    const messages = transcriptWith(launchRow());
    const landed = landTaskLifecycles(messages, [{ task: finished(), output: "FAIL brainpodClock\n" }]);

    expect(landed).toHaveLength(3);
    expect(landed[2]?.content).toBe("Review complete.");
    const row = landed[1]?.toolCalls?.[0];
    expect(row?.id).toBe("call_bash");
    expect(row?.isError).toBe(true);
    expect(row?.result).toContain("FAIL brainpodClock");
    expect(row?.metadata).toMatchObject({ taskId: "task_0002", taskLifecycle: "failed", exitCode: 1, outputLines: 89 });
    // parts mirror toolCalls so the timeline renderer sees the same row.
    const part = landed[1]?.parts?.[0];
    expect(part?.type === "tools" ? part.toolCalls[0]?.metadata?.taskLifecycle : undefined).toBe("failed");

    const [group] = buildTraceGroups([row!]);
    expect(group?.title).toBe("Task failed");
    expect(group?.statusLabel).toBe("task_0002 · in 17s · exit 1 · 89 lines");
  });

  it("keeps the launch text when the task produced no output", () => {
    const landed = applyTaskLifecycleToMessages(transcriptWith(launchRow()), finished({ status: "completed", exitCode: 0 }), "   ");
    expect(landed.merged).toBe(true);
    expect(landed.messages[1]?.toolCalls?.[0]?.result).toContain("Started background task");
    expect(landed.messages[1]?.toolCalls?.[0]?.isError).toBe(false);
  });

  it("appends a detached row only when no launch row exists", () => {
    const messages: DisplayMessage[] = [{ key: "a", role: "assistant", content: "done" }];
    const landed = landTaskLifecycles(messages, [{ task: finished(), output: "boom" }]);
    expect(landed).toHaveLength(2);
    expect(landed[1]?.toolCalls?.[0]?.metadata).toMatchObject({ taskId: "task_0002", taskLifecycle: "failed" });
    expect(landed[1]?.toolCalls?.[0]?.id).toMatch(/^task-lifecycle:task_0002:/);
  });

  it("ignores task_output echoes and other tasks' rows", () => {
    const echo: DisplayToolCall = {
      id: "call_out",
      name: "task_output",
      args: { task_ids: ["task_0002"] },
      status: "completed",
      metadata: { kind: "shell", background: true },
    };
    const other = { ...launchRow("call_other"), metadata: { ...launchRow().metadata, taskId: "task_0001" } };
    const landed = applyTaskLifecycleToMessages(transcriptWith(echo).concat(transcriptWith(other)), finished());
    expect(landed.merged).toBe(false);
  });

  it("merges into live accumulator rows in place, skipping rows still running", () => {
    const settled = launchRow();
    const running: DisplayToolCall = { ...launchRow("call_late"), status: "running", result: undefined, metadata: undefined };
    const tools = [running, settled];
    expect(mergeTaskLifecycleIntoLiveTools(tools, finished())).toBe(true);
    expect(settled.metadata?.taskLifecycle).toBe("failed");
    expect(settled.status).toBe("failed");

    running.metadata = { kind: "shell", taskId: "task_0009", background: true };
    expect(mergeTaskLifecycleIntoLiveTools(tools, finished({ id: "task_0009" }))).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { buildTraceGroups } from "../tui/model/trace-groups.js";
import { TaskStatusBarComponent, TasksPaneComponent } from "../tui/components/tasks-pane.js";
import type { DisplayToolCall } from "../tui/model/display-history.js";

function callbacks() {
  return {
    onRender: vi.fn(),
    onOpenWorkflow: vi.fn(),
    onOpenSubagent: vi.fn(),
    onOpenTask: vi.fn(),
    onStopWorkflow: vi.fn(),
    onStopSubagent: vi.fn(),
    onStopTask: vi.fn(),
    onCopyTaskOutput: vi.fn(),
    onEscape: vi.fn(),
  };
}

describe("Grok-style Tasks Pane", () => {
  it("auto-opens the first active workflow and does not duplicate its children under Subagents", () => {
    const cb = callbacks();
    const pane = new TasksPaneComponent(() => ({
      workflows: [{
        runId: "wf-1",
        title: "Review pipeline",
        status: "running",
        agentCount: 0,
        logs: [],
        snapshots: [],
        createdAt: Date.now() - 2_000,
      }],
      groups: [{
        id: "tool-1",
        runId: "wf-1",
        kind: "workflow",
        label: "Review pipeline",
        members: [{
          subAgentId: "child-1",
          nickname: "Ada",
          agentName: "explorer",
          status: "running",
          phase: "Research",
          task: "inspect the repository",
          createdAt: Date.now() - 1_000,
        }],
      }],
      tasks: [],
    }), () => 40, cb);

    const output = pane.render(120).join("\n");
    expect(pane.isOpen()).toBe(true);
    expect(output).toContain("Workflows");
    expect(output).toContain("Review pipeline");
    expect(output).not.toContain("Subagents");
    pane.dispose();
  });

  it("supports keyboard inspect, stop, history toggle, and hides below 12 terminal rows", () => {
    let rows = 40;
    const cb = callbacks();
    const pane = new TasksPaneComponent(() => ({
      workflows: [],
      groups: [{
        id: "single:child-1",
        runId: "run-1",
        kind: "single",
        label: "Ada",
        members: [{ subAgentId: "child-1", nickname: "Ada", status: "running", task: "review" }],
      }],
      tasks: [],
    }), () => rows, cb);

    pane.focused = true;
    pane.render(100);
    pane.handleInput("\r");
    expect(cb.onOpenSubagent).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1" }));
    pane.handleInput("x");
    expect(cb.onStopSubagent).toHaveBeenCalledWith("child-1");
    pane.handleInput("h");
    expect(cb.onRender).toHaveBeenCalled();
    rows = 11;
    expect(pane.render(100)).toEqual([]);
    pane.dispose();
  });

  it("keeps a completed-history entry reachable after an auto-open pane closes", () => {
    let status = "running";
    const cb = callbacks();
    const pane = new TasksPaneComponent(() => ({
      workflows: [],
      groups: [{
        id: "single:child-1",
        runId: "run-1",
        kind: "single",
        label: "Ada",
        members: [{ subAgentId: "child-1", nickname: "Ada", status, task: "review" }],
      }],
      tasks: [],
    }), () => 40, cb);
    const statusBar = new TaskStatusBarComponent(pane);

    expect(pane.render(100).join("\n")).toContain("Ada");
    status = "completed";
    expect(pane.render(100)).toEqual([]);
    expect(statusBar.render(100).join("\n")).toContain("1 completed activity");
    pane.toggle(true);
    expect(pane.render(100).join("\n")).toContain("Ada");
    pane.dispose();
  });

  it("keeps lifecycle echoes out of transcript while retaining launch history", () => {
    const launch: DisplayToolCall = {
      id: "launch",
      name: "spawn_agent",
      args: {},
      status: "running",
      metadata: { kind: "subagent", subagents: [{ subAgentId: "child-1", nickname: "Ada", status: "running" }] },
    };
    const wait: DisplayToolCall = {
      id: "wait",
      name: "wait_agent",
      args: {},
      status: "completed",
      metadata: { kind: "subagent", subagents: [{ subAgentId: "child-1", nickname: "Ada", status: "completed" }] },
    };
    const groups = buildTraceGroups([launch, wait]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: "Subagent", description: "Ada", previewLines: [] });
  });

  it("shows task output lines and supports Ctrl+F inspect plus y copy", () => {
    const cb = callbacks();
    const pane = new TasksPaneComponent(() => ({
      workflows: [],
      groups: [],
      tasks: [{
        kind: "task",
        id: "task_0001",
        command: "npm test",
        description: "Run tests",
        cwd: "/tmp",
        status: "running",
        startedAt: Date.now() - 2_000,
        outputTruncated: false,
        outputLines: 17,
      }],
    }), () => 40, cb);
    pane.focused = true;

    expect(pane.render(100).join("\n")).toContain("17 lines");
    pane.handleInput("\x06");
    expect(cb.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task_0001" }));
    pane.handleInput("y");
    expect(cb.onCopyTaskOutput).toHaveBeenCalledWith("task_0001");
    pane.dispose();
  });
});

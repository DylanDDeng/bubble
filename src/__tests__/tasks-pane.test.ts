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

  // Two turns: Sophie finishes in the first, Bjarne runs in the second.
  function twoTurnPane() {
    const members = [{ subAgentId: "child-1", nickname: "Sophie", status: "running", task: "read refs" }];
    const cb = callbacks();
    const pane = new TasksPaneComponent(() => ({
      workflows: [],
      groups: members.map((member) => ({
        id: `single:${member.subAgentId}`,
        runId: `run-${member.subAgentId}`,
        kind: "single" as const,
        label: member.nickname,
        members: [member],
      })),
      tasks: [],
    }), () => 40, cb);
    const startSecondTurn = () => {
      members.push({ subAgentId: "child-2", nickname: "Bjarne", status: "running", task: "glob workflows" });
    };
    return { pane, members, startSecondTurn, statusBar: new TaskStatusBarComponent(pane) };
  }

  it("drops the history view when a new round of activity starts", () => {
    const { pane, members, startSecondTurn, statusBar } = twoTurnPane();
    pane.render(100);
    members[0]!.status = "completed";
    pane.render(100); // settles and auto-closes

    // The user looks back at the finished subagent, then leaves the pane open.
    pane.toggle(true);
    expect(pane.render(100).join("\n")).toContain("Sophie");

    startSecondTurn();
    const output = pane.render(100).join("\n");
    expect(output).toContain("Bjarne");
    expect(output).not.toContain("Sophie");
    expect(output).toContain("Subagents 1");
    expect(statusBar.render(100).join("\n")).toContain("1 background activity");
    pane.dispose();
  });

  it("drops the history view when the pane is closed, and offers it again once everything settled", () => {
    const { pane, members, startSecondTurn } = twoTurnPane();
    pane.render(100);
    members[0]!.status = "completed";
    pane.render(100);
    pane.toggle(true); // history on
    pane.render(100);
    pane.toggle(); // closed by the user

    startSecondTurn();
    pane.render(100);
    pane.toggle(true); // reopened while Bjarne is running
    const running = pane.render(100).join("\n");
    expect(running).toContain("Bjarne");
    expect(running).not.toContain("Sophie");

    // Once nothing is running, Ctrl+G is the route back to both transcripts.
    members[1]!.status = "completed";
    pane.focused = false;
    pane.render(100);
    pane.toggle(true);
    const settled = pane.render(100).join("\n");
    expect(settled).toContain("Bjarne");
    expect(settled).toContain("Sophie");
    pane.dispose();
  });

  it("keeps the rows of a user who is browsing history inside the pane when new activity starts", () => {
    const { pane, members, startSecondTurn } = twoTurnPane();
    pane.render(100);
    members[0]!.status = "completed";
    pane.render(100);
    pane.toggle(true);
    pane.focused = true;
    pane.render(100);

    startSecondTurn();
    const focused = pane.render(100).join("\n");
    expect(focused).toContain("Sophie");
    expect(focused).toContain("Bjarne");

    // Leaving and closing the pane ends the history view.
    pane.focused = false;
    pane.close();
    pane.toggle(true);
    const reopened = pane.render(100).join("\n");
    expect(reopened).toContain("Bjarne");
    expect(reopened).not.toContain("Sophie");
    pane.dispose();
  });

  it("still lands the final status in place for a user focused on the pane", () => {
    const { pane, members } = twoTurnPane();
    pane.focused = true;
    pane.render(100);
    members[0]!.status = "completed";
    const output = pane.render(100).join("\n");
    expect(pane.isOpen()).toBe(true);
    expect(output).toContain("Sophie");
    pane.dispose();
  });

  // Rows are derived from "still running, or launched this turn".
  function turnPane() {
    const state = {
      turnStartedAt: 1_000 as number | undefined,
      members: [] as Array<{ subAgentId: string; nickname: string; status: string; task: string; createdAt?: number }>,
      tasks: [] as any[],
    };
    const pane = new TasksPaneComponent(() => ({
      workflows: [],
      groups: state.members.map((member) => ({
        id: `single:${member.subAgentId}`,
        runId: `run-${member.subAgentId}`,
        kind: "single" as const,
        label: member.nickname,
        members: [member],
      })),
      tasks: state.tasks,
      turnStartedAt: state.turnStartedAt,
    }), () => 40, callbacks());
    const spawn = (nickname: string, createdAt?: number) => {
      const member = { subAgentId: `id-${nickname}`, nickname, status: "running", task: "work", createdAt };
      state.members.push(member);
      return member;
    };
    const statusBar = new TaskStatusBarComponent(pane);
    const screen = () => {
      const body = pane.render(100); // render first: it drives open/close
      return [...statusBar.render(100), ...body].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    };
    return { pane, state, spawn, screen };
  }

  it("keeps a sibling that finished first in view, and says so in the header", () => {
    const { pane, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", 1_100);
    spawn("Bjarne", 1_200);
    screen();
    sophie.status = "completed";

    const output = screen();
    expect(output).toContain("1 background activity · 1 done · Ctrl+G");
    expect(output).toContain("Subagents 2");
    expect(output).toMatch(/Bjarne[\s\S]*Sophie/); // running rows stay on top
    pane.dispose();
  });

  it("surfaces a sibling that failed instead of letting it vanish", () => {
    const { pane, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", 1_100);
    spawn("Bjarne", 1_200);
    screen();
    sophie.status = "failed";

    const output = screen();
    expect(output).toContain("1 background activity · 1 failed · Ctrl+G");
    expect(output).toContain("× Sophie");
    pane.dispose();
  });

  it("treats subagents launched one after another in the same turn like parallel ones", () => {
    const { pane, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", 1_100);
    screen();
    sophie.status = "completed";
    screen(); // nothing running: the pane closes
    expect(pane.isOpen()).toBe(false);

    spawn("Bjarne", 1_500); // same turn, launched after Sophie finished
    const output = screen();
    expect(pane.isOpen()).toBe(true);
    expect(output).toContain("Bjarne");
    expect(output).toContain("✓ Sophie");
    pane.dispose();
  });

  it("clears the previous turn's finished rows when the next turn starts", () => {
    const { pane, state, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", 1_100);
    screen();
    sophie.status = "completed";
    screen();

    state.turnStartedAt = 2_000;
    spawn("Carl", 2_100);
    const output = screen();
    expect(output).toContain("1 background activity · Ctrl+G");
    expect(output).toContain("Subagents 1");
    expect(output).toContain("Carl");
    expect(output).not.toContain("Sophie");
    pane.dispose();
  });

  it("shows a task from an earlier turn while it runs, and drops it once it ends", () => {
    const { pane, state, spawn, screen } = turnPane();
    const task = { kind: "task", id: "task_0001", command: "npm test", cwd: "/", status: "running", startedAt: 500, outputTruncated: false, outputLines: 0 };
    state.tasks.push(task);
    spawn("Bjarne", 1_100);
    expect(screen()).toContain("npm test");

    task.status = "completed";
    const output = screen();
    expect(output).not.toContain("npm test");
    expect(output).toContain("1 background activity · Ctrl+G");
    pane.dispose();
  });

  it("falls back to hiding finished rows when the launch time is unknown", () => {
    const { pane, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", undefined);
    spawn("Bjarne", 1_200);
    screen();
    sophie.status = "completed";
    expect(screen()).not.toContain("Sophie");
    pane.dispose();
  });

  it("lands the final status in place for a focused user without pulling in older turns", () => {
    const { pane, state, spawn, screen } = turnPane();
    const old = spawn("Oldie", 100); // launched in an earlier turn
    old.status = "completed";
    const bjarne = spawn("Bjarne", 1_200);
    pane.focused = true;
    screen();
    bjarne.status = "completed";

    const output = screen();
    expect(pane.isOpen()).toBe(true);
    expect(output).toContain("✓ Bjarne");
    expect(output).not.toContain("Oldie");
    expect(state.members).toHaveLength(2);
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

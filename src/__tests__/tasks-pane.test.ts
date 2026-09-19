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
        members: [{ subAgentId: "child-1", nickname: "Ada", status, task: "review", createdAt: 1_100 }],
      }],
      tasks: [],
      turnStartedAt: 1_000,
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
      // Same order as the app layout: the status bar is rendered first.
      return [...statusBar.render(100), ...pane.render(100)].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
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

  it("ends the history view on a new turn even when the active count never reaches zero", () => {
    const { pane, state, spawn, screen } = turnPane();
    const old = spawn("Oldie", 100);
    old.status = "completed";
    state.tasks.push({ kind: "task", id: "task_0001", command: "npm run dev", cwd: "/", status: "running", startedAt: 500, outputTruncated: false, outputLines: 0 });
    pane.focused = true;
    screen();
    pane.handleInput("h"); // history on while the task runs
    expect(screen()).toContain("Oldie");
    pane.focused = false; // Escape: back to the composer, pane still open

    state.turnStartedAt = 2_000;
    spawn("Carl", 2_100); // active count goes 1 -> 2, never through 0
    const output = screen();
    expect(output).toContain("Carl");
    expect(output).not.toContain("Oldie");
    pane.dispose();
  });

  it("closes instead of lingering empty when a new turn clears the idle history it was showing", () => {
    const { pane, state, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", 1_100);
    screen();
    sophie.status = "completed";
    screen(); // settled, auto-closed

    pane.toggle(true); // Ctrl+G: look back
    expect(screen()).toContain("Sophie");
    pane.focused = false; // Escape back to the composer, pane still open

    state.turnStartedAt = 2_000; // a turn that launches no background work
    const output = screen();
    expect(pane.isOpen()).toBe(false);
    expect(output).toBe(""); // nothing from this turn: no bar, no "0 completed"

    // Not a manual close: the next activity still auto-opens the pane.
    spawn("Carl", 2_100);
    expect(screen()).toContain("Carl");
    expect(pane.isOpen()).toBe(true);
    pane.dispose();
  });

  it("keeps the status bar in step with the pane within one frame (the bar is laid out first)", () => {
    const { pane, state, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", 1_100);
    // First frame of new activity: the bar already shows the pane as open.
    expect(screen()).toContain("▾ ⠋ 1 background activity");

    sophie.status = "completed";
    // The frame in which everything settles: collapsed marker, no body.
    const settled = screen();
    expect(settled).toContain("▸ ✓ 1 completed activity");
    expect(settled).not.toContain("▾");

    pane.toggle(true);
    screen();
    pane.focused = false;
    state.turnStartedAt = 2_000; // idle history cleared by a turn that launches nothing
    expect(screen()).toBe(""); // closed and hidden within the same frame
    pane.dispose();
  });

  it("counts the outcomes of the rows it lists, history included", () => {
    const { pane, state, spawn, screen } = turnPane();
    const old = spawn("Oldie", 100);
    old.status = "failed";
    spawn("Bjarne", 1_200);
    pane.focused = true;
    screen();
    pane.handleInput("h");

    const output = screen();
    expect(output).toContain("× Oldie");
    expect(output).toContain("1 background activity · 1 failed · Ctrl+G");
    expect(state.members).toHaveLength(2);
    pane.dispose();
  });

  it("reports the listed rows, not the whole session, after a focused turn settles", () => {
    const { pane, spawn, screen } = turnPane();
    for (const name of ["Old1", "Old2", "Old3"]) spawn(name, 100).status = "completed";
    const bjarne = spawn("Bjarne", 1_200);
    pane.focused = true;
    screen();
    bjarne.status = "completed";

    const output = screen();
    expect(output).toContain("✓ Bjarne");
    expect(output).not.toContain("Old1");
    expect(output).toContain("1 completed activity · Ctrl+G");

    // Closed again, the bar still counts this turn's rows, not the session's.
    pane.focused = false;
    pane.close();
    expect(screen()).toContain("▸ ✓ 1 completed activity · Ctrl+G");
    pane.dispose();
  });

  // Issue #72, problem 1: the idle count must not grow with the session.
  it("counts only this turn's work in the idle status bar, however long the session is", () => {
    const { pane, state, spawn, screen } = turnPane();
    let bar = "";
    for (let turn = 1; turn <= 6; turn += 1) {
      state.turnStartedAt = turn * 10_000;
      const agent = spawn(`Agent${turn}`, turn * 10_000 + 10);
      const task = { kind: "task", id: `task_${turn}`, command: `npm test ${turn}`, cwd: "/", status: "running", startedAt: turn * 10_000 + 20, outputTruncated: false, outputLines: 0 };
      state.tasks.push(task);
      screen();
      agent.status = "completed";
      task.status = "completed";
      bar = screen();
    }
    expect(bar).toContain("▸ ✓ 2 completed activities · Ctrl+G");
    expect(bar).not.toContain("12 completed");
    pane.dispose();
  });

  it("hides the status bar on a turn without background work, and Ctrl+G still reaches history", () => {
    const { pane, state, spawn, screen } = turnPane();
    const sophie = spawn("Sophie", 1_100);
    screen();
    sophie.status = "completed";
    expect(screen()).toContain("1 completed activity");

    state.turnStartedAt = 2_000; // next turn launches nothing
    expect(screen()).toBe("");

    pane.toggle(true);
    expect(screen()).toContain("✓ Sophie");
    pane.dispose();
  });

  it("opens this turn's rows on Ctrl+G when there are any, keeping older history behind h", () => {
    const { pane, spawn, screen } = turnPane();
    spawn("Oldie", 100).status = "completed"; // earlier turn
    const sophie = spawn("Sophie", 1_100);
    screen();
    sophie.status = "completed";
    expect(screen()).toContain("▸ ✓ 1 completed activity"); // what Ctrl+G will list

    pane.toggle(true);
    const opened = screen();
    expect(opened).toContain("✓ Sophie");
    expect(opened).not.toContain("Oldie");

    pane.handleInput("h");
    expect(screen()).toContain("Oldie");
    pane.dispose();
  });

  // Issue #72, problem 2: a selection nobody made must not scroll rows away.
  function taskThenSubagents() {
    const ctx = turnPane();
    ctx.state.tasks.push({ kind: "task", id: "task_0001", command: "npm run dev", cwd: "/", status: "running", startedAt: 1_010, outputTruncated: false, outputLines: 3 });
    ctx.screen(); // the task is the only row: it becomes the default selection
    for (const name of ["Ada", "Bjarne", "Carl", "Dana", "Eve", "Finn"]) ctx.spawn(name, 1_100);
    return ctx;
  }

  it("keeps the first running rows visible in an unfocused pane", () => {
    const { pane, screen } = taskThenSubagents();
    const output = screen();
    expect(output).toContain("7 background activities");
    expect(output).toContain("Subagents 6");
    expect(output).toContain("Ada");
    expect(output).toContain("Bjarne");
    pane.dispose();
  });

  it("says how many rows do not fit instead of clipping them silently", () => {
    const { pane, screen } = taskThenSubagents();
    // 40 terminal rows -> 6 pane lines; 9 rows (2 headers + 7 items) do not fit.
    const lines = screen().split("\n");
    expect(lines).toHaveLength(1 + 6);
    expect(lines.at(-1)).toMatch(/… 3 more below · Ctrl\+G/); // Eve, Finn and the task
    pane.dispose();
  });

  it("starts at the top when the pane is focused after an untouched default selection", () => {
    const { pane, screen } = taskThenSubagents();
    screen();
    pane.toggle(true);
    pane.focused = true;
    expect(screen()).toContain("Ada");
    pane.dispose();
  });

  it("still follows a selection the user made, and reports rows above it", () => {
    const { pane, screen } = taskThenSubagents();
    pane.focused = true;
    screen();
    for (let step = 0; step < 6; step += 1) pane.handleInput("j"); // down to the task
    const output = screen();
    expect(output).toContain("npm run dev");
    expect(output).not.toContain("Ada");
    expect(output).toMatch(/… \d+ more above/);
    pane.dispose();
  });

  it("does not reserve an overflow line it has nothing to say on (only collapsed headers hidden)", () => {
    const rows = 20; // -> the 3-line minimum
    const now = 5_000;
    const pane = new TasksPaneComponent(() => ({
      workflows: [{ runId: "wf-1", title: "Pipeline", status: "running", agentCount: 0, logs: [], snapshots: [], createdAt: now }],
      groups: [{ id: "single:a", runId: "run-a", kind: "single" as const, label: "Ada", members: [{ subAgentId: "a", nickname: "Ada", status: "running", task: "x", createdAt: now }] }],
      tasks: [{ kind: "task", id: "task_0001", command: "npm run dev", cwd: "/", status: "running", startedAt: now, outputTruncated: false, outputLines: 0 }] as any,
      turnStartedAt: 1_000,
    }), () => rows, callbacks());
    pane.focused = true;
    pane.render(100);
    // Collapse Workflows and Subagents by clicking their headers, then select the task.
    const click = (y: number) => pane.handleMouse({ kind: "press", y, x: 2, button: 0, release: false, clickCount: 1 } as any);
    click(0); // Workflows header
    pane.render(100); // the window scrolls to the next item: Subagents header is now line 0
    click(0); // Subagents header

    const lines = pane.render(100).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
    expect(lines.join("\n")).toContain("npm run dev");
    expect(lines).toHaveLength(3); // all three lines used; no silent blank slot
    pane.dispose();
  });

  it("hands focus back when the status bar closes a focused pane", () => {
    const cb = callbacks();
    let turnStartedAt = 1_000;
    const members = [{ subAgentId: "s", nickname: "Sophie", status: "completed", task: "read", createdAt: 100 }];
    const pane = new TasksPaneComponent(() => ({
      workflows: [],
      groups: [{ id: "single:s", runId: "run-s", kind: "single" as const, label: "Sophie", members }],
      tasks: [],
      turnStartedAt,
    }), () => 40, cb);
    const statusBar = new TaskStatusBarComponent(pane);

    pane.toggle(true); // Ctrl+G: only older history exists
    pane.focused = true;
    expect(pane.render(100).join("\n")).toContain("Sophie");

    statusBar.handleMouse({ kind: "press", y: 0, x: 2, button: 0, release: false, clickCount: 1 } as any);
    expect(pane.isOpen()).toBe(false);
    expect(cb.onEscape).toHaveBeenCalledTimes(1); // the app returns focus to the editor
    expect(pane.focused).toBe(false);
    turnStartedAt += 0;
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

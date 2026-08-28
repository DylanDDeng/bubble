import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Editor,
  ScrollView,
  TuiAltScreen,
  VStack,
} from "@bubblebrain-ai/pi-tui";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { TuiAnimationClock } from "../tui/animation-clock.js";
import { StreamingMessageComponent } from "../tui/components/streaming-message.js";
import {
  TaskStatusBarComponent,
  TasksPaneComponent,
  type TasksPaneSnapshot,
} from "../tui/components/tasks-pane.js";
import { ResponsiveTranscriptComponent } from "../tui/components/responsive-transcript.js";
import { COMPOSER_EDITOR_OPTIONS, COMPOSER_EDITOR_THEME } from "../tui/composer-style.js";
import type { DisplayMessage } from "../tui/model/display-history.js";

afterEach(() => {
  vi.useRealTimers();
});

function activeTasks(): TasksPaneSnapshot {
  return {
    groups: [],
    workflows: [],
    tasks: ["read", "bash", "write"].map((command, index) => ({
      kind: "task" as const,
      id: `task_${index}`,
      command,
      description: `${command} background work`,
      cwd: "/tmp",
      status: "running" as const,
      startedAt: 1_000 + index,
      outputTruncated: false,
      outputLines: index,
    })),
  };
}

function taskCallbacks() {
  return {
    onRender: vi.fn(),
    onOpenWorkflow: vi.fn(),
    onOpenSubagent: vi.fn(),
    onOpenTask: vi.fn(),
    onStopWorkflow: vi.fn(),
    onStopSubagent: vi.fn(),
    onStopTask: vi.fn(),
    onEscape: vi.fn(),
  };
}

describe("shared TUI animation clock", () => {
  it("coalesces simultaneous task and Agent animation into one render per frame", () => {
    vi.useFakeTimers();
    let snapshot = activeTasks();
    const tasks = new TasksPaneComponent(() => snapshot, () => 62, taskCallbacks());
    const streaming = new StreamingMessageComponent();
    streaming.updateCommandActivity("send_input", false, 191);
    streaming.startSpinner();
    const requestRender = vi.fn();
    const clock = new TuiAnimationClock((elapsedMs) => {
      const streamChanged = streaming.advanceAnimationFrame(elapsedMs);
      const tasksChanged = tasks.advanceAnimationFrame();
      if (streamChanged || tasksChanged) requestRender();
    });

    clock.setActive(streaming.isAnimationActive() || tasks.isAnimationActive());
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3_000);

    // Before the shared clock these two active surfaces each scheduled a
    // 100 ms callback: 60 callbacks for this same 30-frame interval.
    expect(requestRender).toHaveBeenCalledTimes(30);

    streaming.clearToNothing();
    snapshot = {
      ...snapshot,
      tasks: snapshot.tasks.map((task) => ({ ...task, status: "completed", endedAt: 4_000 })),
    };
    clock.setActive(streaming.isAnimationActive() || tasks.isAnimationActive());
    expect(clock.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    clock.dispose();
  });

  it("does not run while idle and leaves no timer after dispose", () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const clock = new TuiAnimationClock(onTick);

    clock.setActive(false);
    vi.advanceTimersByTime(1_000);
    expect(onTick).not.toHaveBeenCalled();

    clock.setActive(true);
    expect(vi.getTimerCount()).toBe(1);
    clock.dispose();
    expect(clock.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("advances only the activity lane, never the projected trace", () => {
    const component = new StreamingMessageComponent();
    const sendInput = {
      id: "send-input-1",
      name: "send_input",
      args: { message: "continue" },
      status: "running" as const,
      result: "delivered",
    };
    component.update({
      content: "Preparing the answer",
      reasoning: "Reviewing the child result",
      tools: [sendInput],
      parts: [{ type: "tools", toolCalls: [sendInput] }],
      phase: "working",
    }, 191);
    component.startSpinner();
    const projectedBefore = component.render(191);
    const laneBefore = component.activityLane.render(191);

    for (let frame = 0; frame < 15; frame += 1) component.advanceAnimationFrame(100);

    expect(component.render(191)).toEqual(projectedBefore);
    expect(component.activityLane.render(191)).not.toEqual(laneBefore);
  });

  it("keeps the fullscreen composer row and scroll anchor fixed for 30 combined frames", async () => {
    const terminal = new VirtualTerminal(191, 62);
    const tui = new TuiAltScreen(terminal);
    const messages: DisplayMessage[] = Array.from({ length: 80 }, (_, index) => ({
      key: `message-${index}`,
      role: "assistant",
      content: `history row ${index}`,
    }));
    const transcript = new ResponsiveTranscriptComponent(() => ({ messages }));
    const streaming = new StreamingMessageComponent();
    streaming.updateCommandActivity("send_input", false, 191);
    streaming.startSpinner();
    const tasks = new TasksPaneComponent(() => activeTasks(), () => 62, taskCallbacks());
    const statusBar = new TaskStatusBarComponent(tasks);
    const editor = new Editor(tui, COMPOSER_EDITOR_THEME, COMPOSER_EDITOR_OPTIONS);
    const scroll = new ScrollView(new VStack([transcript, streaming]), { follow: "end", primary: true });
    tui.setLayoutRoot(new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 0 },
      { component: statusBar, basis: "auto", shrink: 0 },
      { component: tasks, basis: "auto", shrink: 0 },
      { component: streaming.activityLane, basis: "auto", shrink: 0 },
      { component: editor, basis: "auto", shrink: 0 },
    ]));
    tui.setFocus(editor);
    tui.start();
    tui.renderNow(true);
    await terminal.flush();

    const composerRow = () => terminal.getViewport().findIndex((row) => row.includes("┌"));
    const initialComposerRow = composerRow();
    const initialScrollTop = scroll.scrollTop;
    expect(initialComposerRow).toBeGreaterThan(0);
    expect(terminal.getViewport().join("\n")).toContain("3 background activities");
    expect(terminal.getViewport().join("\n")).toContain("send_input");

    for (let frame = 0; frame < 30; frame += 1) {
      streaming.advanceAnimationFrame(100);
      tasks.advanceAnimationFrame();
      tui.renderNow();
      await terminal.flush();
      expect(composerRow()).toBe(initialComposerRow);
      expect(scroll.scrollTop).toBe(initialScrollTop);
    }

    tui.stop({ preserveScreen: true });
  });
});

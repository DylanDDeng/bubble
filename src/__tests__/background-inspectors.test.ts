import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@bubblebrain-ai/pi-tui";
import { SubagentInspectorComponent } from "../tui/components/subagent-inspector.js";
import { WorkflowInspectorComponent } from "../tui/components/workflow-inspector.js";
import { TaskInspectorComponent } from "../tui/components/task-inspector.js";

function expectWidthSafe(rows: string[], width: number): void {
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
}

describe("background activity inspectors", () => {
  it("never emits an over-wide row when the terminal is extremely narrow", () => {
    const member = {
      subAgentId: "child-1",
      nickname: "Ada",
      agentName: "explorer",
      status: "running",
      task: "Inspect a very long repository path without overflowing the terminal",
    };
    const controller = {
      getChildTranscript: () => [{ key: "a", role: "assistant", content: "long child answer" }],
      getChildStreamingTail: () => null,
      stopSubagent: vi.fn(),
    };
    const subagent = new SubagentInspectorComponent({
      agentId: "child-1",
      controller: controller as never,
      getMember: () => member,
      getTerminalRows: () => 8,
      renderOptions: () => ({}),
      onClose: vi.fn(),
      onRender: vi.fn(),
    });
    const workflow = new WorkflowInspectorComponent({
      getSnapshot: () => ({ id: "wf", title: "A long workflow title", status: "running", members: [member] }),
      getTerminalRows: () => 8,
      onClose: vi.fn(),
      onOpenAgent: vi.fn(),
      onStop: vi.fn(),
      onRender: vi.fn(),
    });
    const task = new TaskInspectorComponent({
      id: "task",
      title: "A long task title",
      getStatus: () => "running",
      getOutput: () => "long output line",
      getTerminalRows: () => 8,
      onClose: vi.fn(),
      onStop: vi.fn(),
      onCopy: vi.fn(),
      onRender: vi.fn(),
    });

    for (const width of [1, 2, 4, 20]) {
      expectWidthSafe(subagent.render(width), width);
      expectWidthSafe(workflow.render(width), width);
      expectWidthSafe(task.render(width), width);
    }
  });
});

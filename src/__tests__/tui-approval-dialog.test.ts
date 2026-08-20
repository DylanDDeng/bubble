import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@bubblebrain-ai/pi-tui";
import {
  ApprovalDialogComponent,
  approvalPresentation,
  type ApprovalDialogChoice,
} from "../tui/components/approval-dialog.js";

const bashRequest = {
  type: "bash" as const,
  command: "printf 'permission-popup-demo-2\\n'",
  cwd: "/workspace/project",
};

describe("approval dialog", () => {
  it("builds a request-specific title and preserves the actionable command details", () => {
    expect(approvalPresentation(bashRequest)).toEqual({
      title: "Request approval for printf",
      details: ["printf 'permission-popup-demo-2\\n'", "working directory: /workspace/project"],
    });

    expect(approvalPresentation({
      type: "external_tool",
      toolCallId: "tool-1",
      title: "demo deploy",
      kind: "execute",
      rawInput: { target: "preview" },
      locations: [{ path: "/workspace/app.ts", line: 12 }],
    })).toEqual({
      title: "Request approval for demo deploy",
      details: ['{"target":"preview"}', "/workspace/app.ts:12"],
    });

    expect(approvalPresentation({
      type: "bash",
      command: "printf ok\x1b[2J\x07",
      cwd: "/workspace\x1b]0;owned\x07",
    })).toEqual({
      title: "Request approval for printf",
      details: ["printf ok�", "working directory: /workspace"],
    });
  });

  it("renders a full-width bottom-sheet body and keeps all decisions usable when narrow or short", () => {
    for (const [width, rows] of [[80, 14], [28, 6], [14, 4]] as const) {
      const dialog = new ApprovalDialogComponent(bashRequest, () => rows);
      const rendered = dialog.render(width);
      expect(rendered.length).toBeLessThanOrEqual(rows);
      expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
      const plain = rendered.map(stripTerminalSequences).join("\n");
      expect(plain).toContain("1 (●)");
      expect(plain).toContain("2 (○)");
      expect(plain).toContain("3 (○)");
    }
  });

  it("supports arrows, Tab, number selection, confirm, bypass, and cancellation", () => {
    const dialog = new ApprovalDialogComponent(bashRequest, () => 14);
    const selected: ApprovalDialogChoice[] = [];
    const cancelled = vi.fn();
    dialog.onSelect = (choice) => selected.push(choice);
    dialog.onCancel = cancelled;

    dialog.handleInput("\t");
    dialog.handleInput("\r");
    expect(selected).toEqual(["approve_always"]);

    dialog.handleInput("3");
    dialog.handleInput("\r");
    expect(selected).toEqual(["approve_always", "reject"]);

    dialog.handleInput("\x0f");
    expect(selected).toEqual(["approve_always", "reject", "approve_always"]);

    dialog.handleInput("\x1b");
    dialog.handleInput("\x03");
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
});

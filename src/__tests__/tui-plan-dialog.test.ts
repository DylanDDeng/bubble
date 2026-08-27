import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth, type TUI } from "@bubblebrain-ai/pi-tui";
import { PlanDialogComponent } from "../tui/components/plan-dialog.js";

function createDialog(initialPlan = "1. inspect\n2. implement", rows = 14) {
  const tui = {
    terminal: { rows },
    requestRender: vi.fn(),
  } as unknown as TUI;
  const dialog = new PlanDialogComponent(tui, initialPlan, () => rows);
  dialog.focused = true;
  return dialog;
}

describe("plan dialog", () => {
  it("renders a responsive full-width approval sheet with all actions", () => {
    for (const [width, rows] of [[80, 14], [28, 6], [14, 4]] as const) {
      const dialog = createDialog("1. inspect\n2. implement", rows);
      const rendered = dialog.render(width);
      expect(rendered.length).toBeLessThanOrEqual(rows);
      expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
      const plain = rendered.map(stripTerminalSequences).join("\n");
      expect(plain).toContain("approve");
      expect(plain).toContain("edit");
      expect(plain).toContain("reject");
    }

    expect(createDialog("long plan", 40).render(100)).toHaveLength(18);
  });

  it("approves the original plan with Enter or y", () => {
    const approved = vi.fn();
    const enterDialog = createDialog();
    enterDialog.onApprove = approved;
    enterDialog.handleInput("\r");
    expect(approved).toHaveBeenCalledWith("1. inspect\n2. implement");

    const keyDialog = createDialog("ship it");
    keyDialog.onApprove = approved;
    keyDialog.handleInput("y");
    expect(approved).toHaveBeenLastCalledWith("ship it");
  });

  it("edits multiple lines and saves the final plan with Ctrl+S or Ctrl+D", () => {
    const approved = vi.fn();
    const dialog = createDialog("Step one");
    dialog.onApprove = approved;
    dialog.handleInput("e");
    dialog.handleInput("\r");
    dialog.handleInput("Step two");
    dialog.handleInput("\x13");
    expect(approved).toHaveBeenCalledWith("Step one\nStep two");

    const ctrlDDialog = createDialog("Original");
    ctrlDDialog.onApprove = approved;
    ctrlDDialog.handleInput("e");
    ctrlDDialog.handleInput(" updated");
    ctrlDDialog.handleInput("\x04");
    expect(approved).toHaveBeenLastCalledWith("Original updated");
  });

  it("cancels edits back to the original plan and rejects only from view mode", () => {
    const approved = vi.fn();
    const rejected = vi.fn();
    const dialog = createDialog("Original plan");
    dialog.onApprove = approved;
    dialog.onReject = rejected;

    dialog.handleInput("e");
    dialog.handleInput(" changed");
    dialog.handleInput("\x1b");
    expect(rejected).not.toHaveBeenCalled();
    dialog.handleInput("\r");
    expect(approved).toHaveBeenCalledWith("Original plan");

    const rejectDialog = createDialog();
    rejectDialog.onReject = rejected;
    rejectDialog.handleInput("\x1b");
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("does not save an empty edited plan", () => {
    const approved = vi.fn();
    const dialog = createDialog("x");
    dialog.onApprove = approved;
    dialog.handleInput("e");
    dialog.handleInput("\x7f");
    dialog.handleInput("\x13");

    expect(approved).not.toHaveBeenCalled();
    expect(dialog.render(80).map(stripTerminalSequences).join("\n"))
      .toContain("Plan cannot be empty.");
  });
});

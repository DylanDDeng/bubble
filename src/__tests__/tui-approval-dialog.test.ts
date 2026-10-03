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
  // Set by the approval controller when the host can remember session approvals.
  sessionGrant: "printf 'permission-popup-demo-2\\n'",
};

describe("approval dialog", () => {
  it("offers no session option when the controller attached no session grant", () => {
    const dialog = new ApprovalDialogComponent(
      { type: "bash", command: "git status && rm -rf build", cwd: "/workspace/project" },
      () => 14,
    );
    expect(dialog.render(100).join("\n")).not.toContain("don't ask again");
  });

  it("offers a session approval for MCP tools that carry a session grant", () => {
    const dialog = new ApprovalDialogComponent(
      {
        type: "external_tool",
        toolCallId: "t1",
        title: "mcp__github__create_issue",
        kind: "mcp",
        rawInput: {},
        sessionGrant: "mcp__github__create_issue",
      },
      () => 14,
    );
    const selected: ApprovalDialogChoice[] = [];
    dialog.onSelect = (choice) => selected.push(choice);
    dialog.handleInput("2");
    dialog.handleInput("\r");
    expect(selected).toEqual([{ kind: "approve_session" }]);
  });

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

  it("approves this exact command for the session without enabling global bypass", () => {
    const dialog = new ApprovalDialogComponent(bashRequest, () => 14);
    const selected: ApprovalDialogChoice[] = [];
    const cancelled = vi.fn();
    dialog.onSelect = (choice) => selected.push(choice);
    dialog.onCancel = cancelled;

    expect(dialog.render(100).map(stripTerminalSequences).join("\n"))
      .toContain("don't ask again for this exact command this session");
    dialog.handleInput("\t");
    dialog.handleInput("\r");
    expect(selected).toEqual([{ kind: "approve_session" }]);

    dialog.handleInput("3");
    dialog.handleInput("\r");
    expect(selected).toEqual([{ kind: "approve_session" }, { kind: "reject" }]);

    dialog.handleInput("\x1b");
    dialog.handleInput("\x03");
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("does not offer a remember-or-bypass choice for non-bash tools", () => {
    const dialog = new ApprovalDialogComponent({
      type: "write",
      path: "/workspace/new.txt",
      content: "hello",
      fileExists: false,
    }, () => 14);

    const plain = dialog.render(80).map(stripTerminalSequences).join("\n");
    expect(plain).toContain("1 (●) Yes, proceed");
    expect(plain).toContain("2 (○) No, reject");
    expect(plain).not.toContain("don't ask again");
    expect(plain).not.toContain("Bypass Permissions");
  });
});

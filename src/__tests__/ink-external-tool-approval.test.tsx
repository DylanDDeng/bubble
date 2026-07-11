import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { ApprovalDialog } from "../tui-ink/approval/approval-dialog.js";

describe("external tool approval dialog", () => {
  it("shows the external title, kind, location, and JSON input", () => {
    const output = renderToString(React.createElement(ApprovalDialog, {
      request: {
        type: "external_tool",
        toolCallId: "tool-1",
        title: "Run formatter",
        kind: "execute",
        locations: [{ path: "/tmp/project/src/a.ts", line: 12 }],
        rawInput: { command: "prettier src/a.ts", write: true },
      },
      onDecision: () => {},
    }), { columns: 100 });

    expect(output).toContain("External tool permission");
    expect(output).toContain("Run formatter");
    expect(output).toContain("kind: execute");
    expect(output).toContain("/tmp/project/src/a.ts:12");
    expect(output).toContain('"command": "prettier src/a.ts"');
  });

  it("truncates oversized raw input", () => {
    const output = renderToString(React.createElement(ApprovalDialog, {
      request: {
        type: "external_tool",
        toolCallId: "tool-2",
        title: "Large request",
        kind: "other",
        rawInput: { payload: "x".repeat(5_000) },
      },
      onDecision: () => {},
    }), { columns: 100 });

    expect(output).toContain("… (truncated)");
    expect(output).not.toContain("x".repeat(1_300));
  });
});

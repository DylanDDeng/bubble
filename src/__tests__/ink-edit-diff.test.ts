import { describe, expect, it } from "vitest";
import { formatEditSuccessSummary, getEditDiffDetails } from "../tui/formatting/edit-diff.js";
import type { DisplayToolCall } from "../tui/model/display-history.js";

describe("Ink edit diff helpers", () => {
  it("prefers structured metadata for edit diff details", () => {
    const tool = editTool({
      result: "Edited file\n\nDiff:\n-this fallback should not be used\n",
      metadata: {
        kind: "edit",
        path: "/tmp/a.ts",
        diff: "@@ -1 +1 @@\n-old\n+new\n+added\n",
        addedLines: 2,
        removedLines: 1,
      },
    });

    const details = getEditDiffDetails(tool);

    expect(details).toMatchObject({
      path: "/tmp/a.ts",
      added: 2,
      removed: 1,
    });
    expect(details?.diff).toContain("+added");
    expect(formatEditSuccessSummary(details)).toBe("Succeeded. File edited. (+2 added, -1 removed)");
  });

  it("falls back to legacy result parsing and strips diagnostics", () => {
    const tool = editTool({
      result: [
        "Edited /tmp/a.ts",
        "",
        "Diff:",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
        "LSP diagnostics in /tmp/a.ts:",
        "warning",
      ].join("\n"),
    });

    const details = getEditDiffDetails(tool);

    expect(details).toMatchObject({ added: 1, removed: 1 });
    expect(details?.diff).toContain("+new");
    expect(details?.diff).not.toContain("LSP diagnostics");
  });
});

function editTool(extra: Partial<DisplayToolCall>): DisplayToolCall {
  return {
    id: "edit-1",
    name: "edit",
    args: { path: "/tmp/fallback.ts" },
    ...extra,
  };
}

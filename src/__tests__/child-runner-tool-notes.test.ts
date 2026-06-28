import { describe, expect, it } from "vitest";
import { summarizeSubagentToolEnd } from "../agent/child-runner.js";
import type { ToolResult } from "../types.js";

function readEnd(metadata: Record<string, unknown>): { name: string; result: ToolResult } {
  return { name: "read", result: { content: "...", status: "success", metadata } };
}

describe("summarizeSubagentToolEnd — paged reads", () => {
  it("renders distinct ranges so paged reads do not collapse into identical notes", () => {
    const a = summarizeSubagentToolEnd(readEnd({ kind: "read", path: "/x.ts", offset: 1, lines: 10, total: 664 }));
    const b = summarizeSubagentToolEnd(readEnd({ kind: "read", path: "/x.ts", offset: 50, lines: 11, total: 664 }));

    expect(a).toBe("read /x.ts (lines 1-10)");
    expect(b).toBe("read /x.ts (lines 50-60)");
    expect(a).not.toBe(b); // the exact defect that made paging look like a loop
  });

  it("renders a full read as a plain note without a range", () => {
    const note = summarizeSubagentToolEnd(readEnd({ kind: "read", path: "/x.ts", offset: 1, lines: 664, total: 664 }));
    expect(note).toBe("read /x.ts");
  });

  it("falls back to the error first-line when the read failed", () => {
    const note = summarizeSubagentToolEnd({
      name: "read",
      result: { content: "Error: file not found\nmore", isError: true, metadata: { kind: "read", path: "/x.ts" } },
    });
    expect(note).toBe("Error: file not found");
  });
});

import { describe, expect, it } from "vitest";
import { formatDiagnostics, normalizeDiagnostics } from "../diagnostics.js";

describe("LSP diagnostics formatting", () => {
  it("deduplicates and sorts by severity then position", () => {
    const diagnostics = normalizeDiagnostics([
      { message: "warning later", severity: 2, source: "eslint", range: { start: { line: 4, character: 1 } } },
      { message: "error later", severity: 1, source: "typescript", range: { start: { line: 3, character: 1 } } },
      { message: "error early", severity: 1, source: "typescript", range: { start: { line: 0, character: 2 } } },
      { message: "error early", severity: 1, source: "typescript", range: { start: { line: 0, character: 2 } } },
    ]);

    expect(diagnostics.map((item) => item.message)).toEqual(["error early", "error later", "warning later"]);
  });

  it("includes summary and source in formatted output", () => {
    const output = formatDiagnostics("/repo/src/a.ts", [
      { message: "warn", severity: 2, source: "eslint", range: { start: { line: 0, character: 0 } } },
      { message: "err", severity: 1, source: "typescript", code: 2322, range: { start: { line: 1, character: 2 } } },
    ], "/repo", { includeSummary: true });

    expect(output).toContain("Summary: 1 error, 1 warning");
    expect(output).toContain("src/a.ts:2:3 error typescript [2322]: err");
    expect(output).toContain("src/a.ts:1:1 warning eslint: warn");
  });
});

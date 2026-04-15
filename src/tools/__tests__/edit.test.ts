import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEditTool } from "../edit.js";

describe("edit tool", () => {
  const tmpDir = join(tmpdir(), "bubble-test-edit-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("applies a single replacement", async () => {
    const file = join(tmpDir, "sample.ts");
    writeFileSync(file, "const x = 1;\nconst y = 2;", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "sample.ts",
        edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }],
      },
      { cwd: tmpDir }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Edited");
    expect(result.content).toContain("42");
  });

  it("applies multiple replacements simultaneously", async () => {
    const file = join(tmpDir, "multi.ts");
    writeFileSync(file, "a\nb\nc", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "multi.ts",
        edits: [
          { oldText: "a", newText: "A" },
          { oldText: "c", newText: "C" },
        ],
      },
      { cwd: tmpDir }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("A");
    expect(result.content).toContain("C");
  });

  it("returns error when oldText is not found", async () => {
    const file = join(tmpDir, "missing.ts");
    writeFileSync(file, "hello", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "missing.ts",
        edits: [{ oldText: "not-found", newText: "x" }],
      },
      { cwd: tmpDir }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error when oldText appears multiple times", async () => {
    const file = join(tmpDir, "duplicate.ts");
    writeFileSync(file, "abc abc", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "duplicate.ts",
        edits: [{ oldText: "abc", newText: "x" }],
      },
      { cwd: tmpDir }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Must be unique");
  });
});

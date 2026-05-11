import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("matches across CRLF files and preserves CRLF line endings", async () => {
    const file = join(tmpDir, "crlf.ts");
    writeFileSync(file, "const x = 1;\r\nconst y = 2;\r\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "crlf.ts",
        edits: [{ oldText: "const x = 1;\nconst y = 2;", newText: "const x = 1;\nconst y = 3;" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("const x = 1;\r\nconst y = 3;\r\n");
  });

  it("preserves a UTF-8 BOM when editing", async () => {
    const file = join(tmpDir, "bom.ts");
    writeFileSync(file, "\uFEFFexport const value = 1;\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "bom.ts",
        edits: [{ oldText: "export const value = 1;", newText: "export const value = 2;" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("\uFEFFexport const value = 2;\n");
  });

  it("uses normalized line matching for blank-line differences", async () => {
    const file = join(tmpDir, "blank-lines.css");
    writeFileSync(file, ".game-overlay p {\n  color: #999;\n}\n\n@keyframes fadeIn {\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "blank-lines.css",
        edits: [
          {
            oldText: ".game-overlay p {\n  color: #999;\n}\n@keyframes fadeIn {",
            newText: ".game-overlay p {\n  color: #777;\n}\n\n@keyframes fadeIn {",
          },
        ],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("normalized line matching");
    expect(readFileSync(file, "utf-8")).toContain("color: #777;");
  });

  it("rejects ambiguous normalized line matches", async () => {
    const file = join(tmpDir, "ambiguous.css");
    writeFileSync(file, ".item {\n  color: red;\n}\n\n.item {\n  color: red;\n}\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "ambiguous.css",
        edits: [{ oldText: ".item {\n  color: red;\n}", newText: ".item {\n  color: blue;\n}" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("appears 2 times");
  });

  it("rejects overlapping edits", async () => {
    const file = join(tmpDir, "overlap.ts");
    writeFileSync(file, "alpha\nbeta\ngamma\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "overlap.ts",
        edits: [
          { oldText: "alpha\nbeta", newText: "ALPHA\nBETA" },
          { oldText: "beta\ngamma", newText: "BETA\nGAMMA" },
        ],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("overlap");
    expect(readFileSync(file, "utf-8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("rejects paths outside the workspace", async () => {
    const outside = join(tmpdir(), "bubble-outside-edit-test.txt");
    writeFileSync(outside, "outside", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: resolve(outside),
        edits: [{ oldText: "outside", newText: "changed" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(readFileSync(outside, "utf-8")).toBe("outside");
  });
});

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
    expect(result.metadata).toMatchObject({
      kind: "edit",
      path: file,
      addedLines: 1,
      removedLines: 1,
    });
    expect(result.metadata?.diff).toContain("-const x = 1;");
    expect(result.metadata?.diff).toContain("+const x = 42;");
  });

  it("normalizes legacy top-level oldText/newText arguments", async () => {
    const file = join(tmpDir, "legacy-top-level.ts");
    writeFileSync(file, "const value = 1;\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const args = tool.prepareArguments?.({
      path: "legacy-top-level.ts",
      oldText: "const value = 1;",
      newText: "const value = 2;",
    });
    const result = await tool.execute(args ?? {}, { cwd: tmpDir });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("const value = 2;\n");
  });

  it("normalizes provider variants for edits arguments", async () => {
    const file = join(tmpDir, "provider-variants.ts");
    writeFileSync(file, "const label = 'old';\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const args = tool.prepareArguments?.({
      file_path: "provider-variants.ts",
      edits: JSON.stringify([{ old_string: "const label = 'old';", new_string: "const label = 'new';" }]),
    });
    const result = await tool.execute(args ?? {}, { cwd: tmpDir });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("const label = 'new';\n");
  });

  it("does not append legacy top-level replacements when edits already exists", async () => {
    const file = join(tmpDir, "mixed-legacy.ts");
    writeFileSync(file, "const first = 1;\nconst second = 2;\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const args = tool.prepareArguments?.({
      path: "mixed-legacy.ts",
      edits: [{ oldText: "const first = 1;", newText: "const first = 10;" }],
      oldText: "const second = 2;",
      newText: "const second = 20;",
    });
    const result = await tool.execute(args ?? {}, { cwd: tmpDir });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("const first = 10;\nconst second = 2;\n");
  });

  it("returns a clear error when edits is not an array", async () => {
    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { path: "sample.ts", edits: "{\"oldText\":\"x\",\"newText\":\"y\"}" },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("edits to be an array");
  });

  it("returns a clear error when an edit item is malformed", async () => {
    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { path: "sample.ts", edits: [{ oldText: "const x = 1;" }] },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("edits[0]");
    expect(result.content).toContain("oldText and newText");
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

  it("rejects an edit whose oldText equals newText byte-for-byte", async () => {
    const file = join(tmpDir, "no-op.ts");
    writeFileSync(file, "const color = '#ec489';\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "no-op.ts",
        edits: [{ oldText: "'#ec489'", newText: "'#ec489'" }],
      },
      { cwd: tmpDir }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("byte-identical");
    expect(result.content).toContain("tokenizer");
    expect(readFileSync(file, "utf-8")).toBe("const color = '#ec489';\n");
  });

  it("flags the specific index when only one edit in a batch is a no-op", async () => {
    const file = join(tmpDir, "mixed-noop.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "mixed-noop.ts",
        edits: [
          { oldText: "const a = 1;", newText: "const a = 100;" },
          { oldText: "const b = 2;", newText: "const b = 2;" },
        ],
      },
      { cwd: tmpDir }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("edits[1]");
    expect(readFileSync(file, "utf-8")).toBe("const a = 1;\nconst b = 2;\n");
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
    expect(result.status).toBe("no_match");
    expect(result.metadata).toMatchObject({
      kind: "edit",
      path: file,
      reason: "no_match",
    });
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

  it("matches when oldText has extra leading and trailing newlines", async () => {
    const file = join(tmpDir, "extra-newlines.ts");
    writeFileSync(file, "function hello() {\n  return 'world';\n}\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "extra-newlines.ts",
        edits: [{
          oldText: "\nfunction hello() {\n  return 'world';\n}\n",
          newText: "function hello() {\n  return 'bubble';\n}",
        }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("function hello() {\n  return 'bubble';\n}\n");
  });

  it("matches over-escaped newline sequences in oldText", async () => {
    const file = join(tmpDir, "escaped-newline.txt");
    writeFileSync(file, "label = \"hello\nworld\"\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "escaped-newline.txt",
        edits: [{
          oldText: "label = \"hello\\nworld\"",
          newText: "label = \"hello\nbubble\"",
        }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("label = \"hello\nbubble\"\n");
  });

  it("matches over-escaped unicode sequences in oldText", async () => {
    const file = join(tmpDir, "escaped-unicode.txt");
    writeFileSync(file, "when \"\u000c\" then :ctrl_l\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "escaped-unicode.txt",
        edits: [{
          oldText: "when \"\\u000C\" then :ctrl_l",
          newText: "when \"\u000c\" then :ctrl_l # form-feed",
        }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toContain("# form-feed");
  });

  it("matches code blocks when only leading indentation differs", async () => {
    const file = join(tmpDir, "indent.ts");
    writeFileSync(file, "function run() {\n    doWork();\n}\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "indent.ts",
        edits: [{
          oldText: "function run() {\n\tdoWork();\n}",
          newText: "function run() {\n    doBetterWork();\n}",
        }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("function run() {\n    doBetterWork();\n}\n");
  });

  it("matches markdown table rows when only alignment spaces differ", async () => {
    const file = join(tmpDir, "table.md");
    writeFileSync(
      file,
      "| Layer  | Choice                         |\n| ------ | ------------------------------ |\n| 框架   | Next.js 14 (App Router)        |\n",
      "utf-8",
    );

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "table.md",
        edits: [
          {
            oldText: "| 框架 | Next.js 14 (App Router) |",
            newText: "| 框架 | Next.js 16 (App Router) |",
          },
        ],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("normalized line matching");
    expect(readFileSync(file, "utf-8")).toContain("| 框架 | Next.js 16 (App Router) |");
  });

  it("rejects ambiguous markdown table alignment matches", async () => {
    const file = join(tmpDir, "ambiguous-table.md");
    writeFileSync(
      file,
      "| Name  | Value |\n| ----- | ----- |\n| 框架   | Next.js 14 (App Router)        |\n| 框架     | Next.js 14 (App Router)      |\n",
      "utf-8",
    );

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "ambiguous-table.md",
        edits: [
          {
            oldText: "| 框架 | Next.js 14 (App Router) |",
            newText: "| 框架 | Next.js 16 (App Router) |",
          },
        ],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("matched 2 markdown table rows");
    expect(readFileSync(file, "utf-8")).toContain("Next.js 14");
  });

  it("matches single document lines when only inline whitespace differs", async () => {
    const file = join(tmpDir, "notes.md");
    writeFileSync(file, "Status:   ready    now\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "notes.md",
        edits: [{ oldText: "Status: ready now", newText: "Status: shipped now" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("Status: shipped now\n");
  });

  it("does not whitespace-normalize single-line matches in code files", async () => {
    const file = join(tmpDir, "code.ts");
    writeFileSync(file, "const label = \"Status:   ready    now\";\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "code.ts",
        edits: [{ oldText: "const label = \"Status: ready now\";", newText: "const label = \"Status: shipped now\";" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    expect(readFileSync(file, "utf-8")).toBe("const label = \"Status:   ready    now\";\n");
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

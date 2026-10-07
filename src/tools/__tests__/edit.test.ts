import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../approval/types.js";
import { createEditTool } from "../edit.js";

function extractCurrentCandidateExcerpt(content: string): string {
  const headerIndex = content.indexOf("Current candidate excerpt");
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  const fenceStart = content.indexOf("```", headerIndex);
  expect(fenceStart).toBeGreaterThanOrEqual(0);
  const excerptStart = fenceStart + "```\n".length;
  const fenceEnd = content.indexOf("\n```", excerptStart);
  expect(fenceEnd).toBeGreaterThanOrEqual(0);
  return content.slice(excerptStart, fenceEnd);
}

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

  it("allows adjacent but non-overlapping edit entries", async () => {
    const file = join(tmpDir, "adjacent.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "adjacent.ts",
        edits: [
          { oldText: "alpha\n", newText: "ALPHA\n" },
          { oldText: "beta", newText: "BETA" },
        ],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("ALPHA\nBETA\n");
  });

  it("exposes edit guidance without hard batching pressure", () => {
    const tool = createEditTool(tmpDir);
    const promptText = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

    expect(tool.promptSnippet).toContain("multiple disjoint edits in one call");
    expect(promptText).toContain("copied verbatim from a fresh read");
    expect(promptText).toContain("Do not reconstruct oldText from memory, stale reads, or similar code elsewhere.");
    expect(promptText).toContain("Use separate smaller edit calls after re-reading");
    expect(promptText).toContain("merge only truly overlapping targets");
    expect(promptText).not.toContain("nearby lines");
    expect(promptText).not.toContain("Merge nearby changes");
    expect(promptText).not.toContain("instead of multiple edit calls");
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

  it("includes a bounded current candidate excerpt for high-confidence no_match hints", async () => {
    const file = join(tmpDir, "missing-high-confidence.ts");
    writeFileSync(
      file,
      [
        "before",
        "line one stable",
        `line two current ${"x".repeat(1400)}`,
        "line three stable",
        "after",
      ].join("\n"),
      "utf-8",
    );

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "missing-high-confidence.ts",
        edits: [{ oldText: "line one stable\nline two stale\nline three stable", newText: "replacement" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("no_match");
    expect(result.content).toContain("Closest line-based candidate starts near line 2 and matched 2/3 non-blank lines.");
    expect(result.content).toContain("Current candidate excerpt (high confidence, current file lines 1-5, not guaranteed target):");
    expect(result.content).toContain("line two current");
    expect(result.content).toContain("...[truncated current candidate excerpt]");
    expect(result.content).not.toContain("2: line one stable");
    const excerpt = extractCurrentCandidateExcerpt(result.content);
    expect(excerpt.length).toBeLessThanOrEqual(1200);
    expect(excerpt.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("does not include current bytes for low-confidence no_match hints", async () => {
    const file = join(tmpDir, "missing-low-confidence.ts");
    writeFileSync(file, "alpha\ncurrent beta\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "missing-low-confidence.ts",
        edits: [{ oldText: "alpha\nmissing beta", newText: "replacement" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Closest low-confidence line-based candidate starts near line 1 and matched 1/2 non-blank lines.");
    expect(result.content).toContain("Current bytes were not included because the candidate may be unrelated.");
    expect(result.content).not.toContain("Current candidate excerpt");
    expect(result.content).not.toContain("current beta");
  });

  it("includes current bytes at the 2/4 no_match confidence boundary", async () => {
    const file = join(tmpDir, "missing-confidence-2-of-4.ts");
    writeFileSync(file, "alpha\ncurrent beta\ngamma\ncurrent delta\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "missing-confidence-2-of-4.ts",
        edits: [{ oldText: "alpha\nstale beta\ngamma\nstale delta", newText: "replacement" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Closest line-based candidate starts near line 1 and matched 2/4 non-blank lines.");
    expect(result.content).toContain("Current candidate excerpt");
    expect(result.content).toContain("current beta");
  });

  it("does not include current bytes below the 2/5 no_match confidence boundary", async () => {
    const file = join(tmpDir, "missing-confidence-2-of-5.ts");
    writeFileSync(file, "alpha\ncurrent beta\ngamma\ncurrent delta\ncurrent epsilon\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "missing-confidence-2-of-5.ts",
        edits: [{ oldText: "alpha\nstale beta\ngamma\nstale delta\nstale epsilon", newText: "replacement" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Closest low-confidence line-based candidate starts near line 1 and matched 2/5 non-blank lines.");
    expect(result.content).not.toContain("Current candidate excerpt");
    expect(result.content).not.toContain("current beta");
  });

  it("does not include current bytes when multiple best line hints tie", async () => {
    const file = join(tmpDir, "missing-tied-candidates.ts");
    writeFileSync(
      file,
      "alpha\ncurrent one\nomega\nalpha\ncurrent two\nomega\n",
      "utf-8",
    );

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "missing-tied-candidates.ts",
        edits: [{ oldText: "alpha\nmissing\nomega", newText: "replacement" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Closest ambiguous line-based candidate starts near line 1 and matched 2/3 non-blank lines, but 2 candidates tied.");
    expect(result.content).toContain("Current bytes were not included because the candidate may be unrelated.");
    expect(result.content).not.toContain("Current candidate excerpt");
    expect(result.content).not.toContain("current one");
    expect(result.content).not.toContain("current two");
  });

  it("does not leak current bytes from sensitive paths in no_match hints", async () => {
    const sensitiveRoot = join(tmpDir, "bubble-home-edit");
    mkdirSync(sensitiveRoot, { recursive: true });
    const previous = process.env.BUBBLE_HOME;
    process.env.BUBBLE_HOME = sensitiveRoot;
    try {
      const file = join(sensitiveRoot, "config.json");
      writeFileSync(file, "public line\nsecret = super-secret-token\nstable tail\n", "utf-8");

      const tool = createEditTool(sensitiveRoot);
      const result = await tool.execute(
        {
          path: "config.json",
          edits: [{ oldText: "public line\nstale secret\nstable tail", newText: "replacement" }],
        },
        { cwd: sensitiveRoot },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Closest line-based candidate starts near line 1 and matched 2/3 non-blank lines.");
      expect(result.content).toContain("Current bytes were not included because this path is blocked by the sensitive-path read policy.");
      expect(result.content).not.toContain("Current candidate excerpt");
      expect(result.content).not.toContain("super-secret-token");
    } finally {
      if (previous === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previous;
    }
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

  it("rejects oldText whose indentation differs instead of guessing a location", async () => {
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

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    expect(result.content).toContain("near line 1");
    expect(readFileSync(file, "utf-8")).toBe("function run() {\n    doWork();\n}\n");
  });

  it("rejects markdown table rows whose alignment spaces differ", async () => {
    const file = join(tmpDir, "table.md");
    const original = "| Layer  | Choice                         |\n| ------ | ------------------------------ |\n| 框架   | Next.js 14 (App Router)        |\n";
    writeFileSync(file, original, "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "table.md",
        edits: [{ oldText: "| 框架 | Next.js 14 (App Router) |", newText: "| 框架 | Next.js 16 (App Router) |" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  it("does not unescape over-escaped oldText", async () => {
    const file = join(tmpDir, "escaped-newline.txt");
    writeFileSync(file, "label = \"hello\nworld\"\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        path: "escaped-newline.txt",
        edits: [{ oldText: "label = \"hello\\nworld\"", newText: "label = \"hello\nbubble\"" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("label = \"hello\nworld\"\n");
  });

  it("matches oldText that includes the BOM copied from the start of a file", async () => {
    const file = join(tmpDir, "bom-copied.ts");
    writeFileSync(file, "\uFEFFexport const value = 1;\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { path: "bom-copied.ts", edits: [{ oldText: "\uFEFFexport const value = 1;", newText: "\uFEFFexport const value = 2;" }] },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("\uFEFFexport const value = 2;\n");
  });

  it("does not report normalized matching notes on exact edits", async () => {
    const file = join(tmpDir, "crlf-bom.cs");
    writeFileSync(file, "\uFEFFclass A {\r\n  int X;\r\n}\r\n", "utf-8");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { path: "crlf-bom.cs", edits: [{ oldText: "  int X;\n}", newText: "  int X;\n  int Y;\n}" }] },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).not.toContain("Note:");
    expect(readFileSync(file, "utf-8")).toBe("\uFEFFclass A {\r\n  int X;\r\n  int Y;\r\n}\r\n");
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

  it("escalates outside-workspace paths to the approval controller instead of hard-blocking", async () => {
    const outside = join(tmpdir(), "bubble-outside-edit-test.txt");
    writeFileSync(outside, "outside", "utf-8");

    const approvalRequests: ApprovalRequest[] = [];
    const tool = createEditTool(tmpDir, {
      checkRules: () => ({ decision: "ask" as const }),
      request: async (request: ApprovalRequest) => {
        approvalRequests.push(request);
        return { action: "reject" as const };
      },
    });
    const result = await tool.execute(
      {
        path: resolve(outside),
        edits: [{ oldText: "outside", newText: "changed" }],
      },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({ type: "edit", outsideWorkspace: true });
    expect(readFileSync(outside, "utf-8")).toBe("outside");
  });
});

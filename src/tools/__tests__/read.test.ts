import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalController } from "../../approval/types.js";
import { buildRuleSet, checkPermission } from "../../permissions/rule.js";
import { createReadTool } from "../read.js";

function makeApproval(allow: string[], deny: string[]): ApprovalController {
  const rules = buildRuleSet(allow, deny);
  return {
    request: async () => ({ action: "approve" }),
    checkRules: (query) => checkPermission(rules, query),
  };
}

describe("read tool", () => {
  const tmpDir = join(tmpdir(), "bubble-test-read-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("reads a simple file", async () => {
    const file = join(tmpDir, "hello.txt");
    writeFileSync(file, "hello world", "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "hello.txt" }, { cwd: tmpDir });

    expect(result.content).toBe("hello world");
    expect(result.isError).toBeUndefined();
  });

  it("reads with offset and limit", async () => {
    const file = join(tmpDir, "lines.txt");
    writeFileSync(file, "line1\nline2\nline3\nline4\nline5", "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "lines.txt", offset: 2, limit: 2 }, { cwd: tmpDir });

    expect(result.content).toBe("line2\nline3");
    // Range metadata lets the subagent tool-note summarizer distinguish paged reads.
    expect(result.metadata?.offset).toBe(2);
    expect(result.metadata?.lines).toBe(2);
    expect(result.metadata?.total).toBe(5);
  });

  it("reports a full read as offset 1 spanning every line", async () => {
    const file = join(tmpDir, "whole.txt");
    writeFileSync(file, "a\nb\nc", "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "whole.txt" }, { cwd: tmpDir });

    expect(result.metadata?.offset).toBe(1);
    expect(result.metadata?.lines).toBe(3);
    expect(result.metadata?.total).toBe(3);
  });

  it("returns error for non-existent file", async () => {
    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "does-not-exist.txt" }, { cwd: tmpDir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot read file");
  });

  it("suggests similar files when a requested file is missing", async () => {
    writeFileSync(join(tmpDir, "tetris_game.py"), "print('game')", "utf-8");
    writeFileSync(join(tmpDir, "tetris.html"), "<canvas></canvas>", "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "tetris.py" }, { cwd: tmpDir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot read file");
    expect(result.content).toContain("Did you mean one of these?");
    expect(result.content).toContain(join(tmpDir, "tetris_game.py"));
    expect(result.content).toContain(join(tmpDir, "tetris.html"));
    expect(result.content.indexOf("tetris_game.py")).toBeLessThan(result.content.indexOf("tetris.html"));
  });

  it("suggests the cwd-local path when an absolute path drops the project directory", async () => {
    const fileName = `bubble-dropped-cwd-${process.pid}-${Date.now()}.txt`;
    const existing = join(tmpDir, fileName);
    const missing = join(tmpdir(), fileName);
    writeFileSync(existing, "under cwd", "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: missing }, { cwd: tmpDir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`Did you mean ${existing}?`);
  });

  it("expands home-directory paths before resolving", async () => {
    const fileName = `.bubble-read-home-${process.pid}-${Date.now()}.txt`;
    const file = join(homedir(), fileName);
    writeFileSync(file, "home visible", "utf-8");

    try {
      const tool = createReadTool(tmpDir);
      const result = await tool.execute({ path: `~/${fileName}` }, { cwd: tmpDir });

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("home visible");
      expect(result.metadata?.path).toBe(file);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("deny rule blocks reads before touching disk", async () => {
    const file = join(tmpDir, "secret.env");
    writeFileSync(file, "SECRET=abc", "utf-8");

    const approval = makeApproval([], [`Read(${tmpDir}/*.env)`]);
    const tool = createReadTool(tmpDir, approval);
    const result = await tool.execute({ path: "secret.env" }, { cwd: tmpDir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("deny rule");
    expect(result.content).not.toContain("SECRET=abc");
  });

  it("reads normally when no deny rule matches", async () => {
    const file = join(tmpDir, "ok.txt");
    writeFileSync(file, "visible", "utf-8");

    const approval = makeApproval([], ["Read(/tmp/nonexistent/**)"]);
    const tool = createReadTool(tmpDir, approval);
    const result = await tool.execute({ path: "ok.txt" }, { cwd: tmpDir });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("visible");
  });

  it("truncates large files", async () => {
    const file = join(tmpDir, "huge.txt");
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    writeFileSync(file, lines.join("\n"), "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "huge.txt" }, { cwd: tmpDir });

    expect(result.content).toContain("Output truncated");
  });

  it("returns a stub when the same range is re-read on an unchanged file", async () => {
    const file = join(tmpDir, "dedup.txt");
    writeFileSync(file, "alpha\nbeta\ngamma", "utf-8");

    const tool = createReadTool(tmpDir);
    const first = await tool.execute({ path: "dedup.txt" }, { cwd: tmpDir });
    expect(first.content).toContain("alpha");

    const second = await tool.execute({ path: "dedup.txt" }, { cwd: tmpDir });
    expect(second.content).toContain("File unchanged since last read");
    expect(second.metadata?.dedup).toBe("unchanged");
  });

  it("auto-advances to the next page when a truncated read is repeated", async () => {
    const file = join(tmpDir, "paged.txt");
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(file, lines.join("\n"), "utf-8");

    const tool = createReadTool(tmpDir);

    const first = await tool.execute({ path: "paged.txt" }, { cwd: tmpDir });
    expect(first.content).toContain("line 1");
    expect(first.content).toContain("Output truncated");
    expect(first.metadata?.truncated).toBe(true);

    const second = await tool.execute({ path: "paged.txt" }, { cwd: tmpDir });
    expect(second.metadata?.autoAdvanced).toBe(true);
    expect(second.content).toContain("Auto-advanced");
    expect(second.content).toContain("line 2501");
    expect(second.content).not.toContain("line 1\n");

    const third = await tool.execute({ path: "paged.txt" }, { cwd: tmpDir });
    expect(third.content).toContain("line 5001");
    expect(third.content).not.toContain("Output truncated");

    const fourth = await tool.execute({ path: "paged.txt" }, { cwd: tmpDir });
    expect(fourth.content).toContain("End of file reached");
  });

  it("does not dedup when the file changes on disk", async () => {
    const file = join(tmpDir, "mutating.txt");
    writeFileSync(file, "v1", "utf-8");

    const tool = createReadTool(tmpDir);
    const first = await tool.execute({ path: "mutating.txt" }, { cwd: tmpDir });
    expect(first.content).toBe("v1");

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(file, "v2", "utf-8");

    const second = await tool.execute({ path: "mutating.txt" }, { cwd: tmpDir });
    expect(second.content).toBe("v2");
    expect(second.metadata?.dedup).toBeUndefined();
  });

  it("blocks reads from sensitive credential storage paths", async () => {
    const sensitiveRoot = join(tmpDir, "bubble-home");
    mkdirSync(sensitiveRoot, { recursive: true });
    const previous = process.env.BUBBLE_HOME;
    process.env.BUBBLE_HOME = sensitiveRoot;
    try {
      const file = join(sensitiveRoot, "config.json");
      writeFileSync(file, JSON.stringify({ apiKey: "secret" }), "utf-8");

      const tool = createReadTool(tmpDir);
      const result = await tool.execute({ path: file }, { cwd: tmpDir });

      expect(result.isError).toBe(true);
      expect(result.status).toBe("blocked");
      expect(result.content).not.toContain("secret");
    } finally {
      if (previous === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previous;
    }
  });
});

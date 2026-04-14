import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadTool } from "../read.js";

describe("read tool", () => {
  const tmpDir = join(tmpdir(), "my-coding-agent-test-read-" + Date.now());
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
  });

  it("returns error for non-existent file", async () => {
    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "does-not-exist.txt" }, { cwd: tmpDir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot read file");
  });

  it("truncates large files", async () => {
    const file = join(tmpDir, "huge.txt");
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    writeFileSync(file, lines.join("\n"), "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "huge.txt" }, { cwd: tmpDir });

    expect(result.content).toContain("Output truncated");
  });
});

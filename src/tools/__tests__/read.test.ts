import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  });

  it("returns error for non-existent file", async () => {
    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "does-not-exist.txt" }, { cwd: tmpDir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot read file");
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
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    writeFileSync(file, lines.join("\n"), "utf-8");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "huge.txt" }, { cwd: tmpDir });

    expect(result.content).toContain("Output truncated");
  });
});

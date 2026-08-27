import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../grep.js";

describe("grep tool", () => {
  const created: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-grep-"));
    created.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("enforces the default match limit globally across files", async () => {
    const dir = makeDir();
    for (let file = 0; file < 3; file++) {
      writeFileSync(
        join(dir, `file-${file}.txt`),
        Array.from({ length: 60 }, (_, line) => `needle ${file}-${line}`).join("\n"),
      );
    }

    const result = await createGrepTool(dir).execute({ pattern: "needle" }, { cwd: dir });

    expect(result.status).toBe("partial");
    expect(result.metadata?.collectedMatches).toBe(100);
    expect(result.metadata?.matches).toBe(100);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content).toContain("global limit of 100 matches");
    expect(result.content.split("\n").filter((line) => /needle \d-\d+/.test(line))).toHaveLength(100);
  });

  it("honors a smaller explicit limit", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "small.txt"), "hit 1\nhit 2\nhit 3\nhit 4\n");

    const result = await createGrepTool(dir).execute({ pattern: "hit", limit: 3 }, { cwd: dir });

    expect(result.metadata?.collectedMatches).toBe(3);
    expect(result.metadata?.matches).toBe(3);
    expect(result.content).toContain("global limit of 3 matches");
  });

  it("caps long UTF-8 results at 40KiB without replacement characters", async () => {
    const dir = makeDir();
    for (let file = 0; file < 100; file++) {
      writeFileSync(join(dir, `long-${file}.txt`), `needle ${"你😀".repeat(1_500)}\n`);
    }

    const result = await createGrepTool(dir).execute({ pattern: "needle" }, { cwd: dir });

    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(40 * 1024);
    expect(result.content).not.toContain("�");
    expect(result.metadata?.truncated).toBe(true);
    expect(Number(result.metadata?.matches)).toBeLessThan(Number(result.metadata?.collectedMatches));
    expect(result.content).toContain("tool output is capped at 40KiB");
  });

  it("distinguishes no matches from an invalid regular expression", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "text.txt"), "hello\n");
    const tool = createGrepTool(dir);

    const noMatch = await tool.execute({ pattern: "missing" }, { cwd: dir });
    const invalid = await tool.execute({ pattern: "[" }, { cwd: dir });

    expect(noMatch.status).toBe("no_match");
    expect(noMatch.isError).toBeUndefined();
    expect(invalid.status).toBe("command_error");
    expect(invalid.isError).toBe(true);
  });
});

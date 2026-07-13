import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMemoryPaths } from "../memory/index.js";
import { createMemoryTool } from "../tools/memory.js";

describe("memory tools", () => {
  const originalBubbleHome = process.env.BUBBLE_HOME;

  afterEach(() => {
    if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
    else process.env.BUBBLE_HOME = originalBubbleHome;
  });

  it("searches persistent memory as a read-only tool", async () => {
    const root = join(tmpdir(), `bubble-memory-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const cwd = join(root, "project");
    process.env.BUBBLE_HOME = join(root, "home");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const paths = getMemoryPaths(cwd);
    mkdirSync(paths.globalRoot, { recursive: true });
    writeFileSync(paths.globalMemory, "# Bubble Memory\n\n- Use memory_search for prior decisions.\n", "utf-8");

    const tool = createMemoryTool(cwd);
    const result = await tool.execute({ query: "prior decisions" }, { cwd });

    expect(tool.readOnly).toBe(true);
    expect(result.content).toContain("Memory search results");
    expect(result.content).toContain("Use memory_search");
  });

  it("reads memory summaries as a read-only tool", async () => {
    const root = join(tmpdir(), `bubble-memory-summary-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const cwd = join(root, "project");
    process.env.BUBBLE_HOME = join(root, "home");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const paths = getMemoryPaths(cwd);
    mkdirSync(paths.globalRoot, { recursive: true });
    writeFileSync(paths.globalSummary, "# Bubble Memory Summary\n\n## Project Facts\n- Summary is available.\n", "utf-8");

    const tool = createMemoryTool(cwd);
    const result = await tool.execute({ scope: "project" }, { cwd });

    expect(tool.readOnly).toBe(true);
    expect(result.content).toContain("project memory summary");
    expect(result.content).toContain("Summary is available");
  });
});

import { describe, expect, it } from "vitest";
import { createBashTool } from "../bash.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("bash tool", () => {
  const cwd = process.cwd();

  it("executes echo command", async () => {
    const tool = createBashTool(cwd);
    const result = await tool.execute({ command: "echo hello" }, { cwd });

    expect(result.content).toContain("hello");
    expect(result.isError).toBe(false); // echo returns 0
  });

  it("captures stderr separately", async () => {
    const tool = createBashTool(cwd);
    const result = await tool.execute({ command: "echo error >&2" }, { cwd });

    expect(result.content).toContain("stderr:");
    expect(result.content).toContain("error");
  });

  it("returns error for invalid command", async () => {
    const tool = createBashTool(cwd);
    const result = await tool.execute({ command: "this_command_does_not_exist_12345" }, { cwd });

    expect(result.isError).toBe(true);
  });

  it("times out long-running commands", async () => {
    const tool = createBashTool(cwd);
    const result = await tool.execute({ command: "sleep 5", timeout: 0.1 }, { cwd });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("treats grep exit code 1 as no_match instead of command error", async () => {
    const tool = createBashTool(cwd);
    const result = await tool.execute({ command: "grep \"definitely_no_such_pattern_123\" package.json" }, { cwd });

    expect(result.isError).toBe(false);
    expect(result.status).toBe("no_match");
  });

  it("blocks direct bash access to sensitive credential storage", async () => {
    const previous = process.env.BUBBLE_HOME;
    process.env.BUBBLE_HOME = join(tmpdir(), "bubble-sensitive-bash");
    try {
      const tool = createBashTool(cwd);
      const result = await tool.execute({ command: "cat ~/.bubble/config.json" }, { cwd });
      expect(result.isError).toBe(true);
      expect(result.status).toBe("blocked");
    } finally {
      if (previous === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previous;
    }
  });
});

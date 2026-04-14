import { describe, expect, it } from "vitest";
import { createBashTool } from "../bash.js";

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
});

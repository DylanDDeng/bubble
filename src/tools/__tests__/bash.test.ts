import { describe, expect, it } from "vitest";
import { createBashTool } from "../bash.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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

  it("returns cancelled when the abort signal fires", async () => {
    const tool = createBashTool(cwd);
    const controller = new AbortController();
    const pending = tool.execute({ command: "sleep 5", timeout: 10 }, { cwd, abortSignal: controller.signal });

    setTimeout(() => controller.abort("test abort"), 50);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.content).toContain("cancelled");
  });

  it.skipIf(process.platform === "win32")("does not hang when a background child inherits stdio", async () => {
    const dir = join(tmpdir(), "bubble-bash-inherited-stdio-" + Date.now());
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dir, "child.pid");
    const script = [
      "const fs=require('fs')",
      "const {spawn}=require('child_process')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>process.stdout.write(\"tick\\\\n\"),100)'],{stdio:'inherit'})",
      "fs.writeFileSync(process.argv[1], String(child.pid))",
      "child.unref()",
      "console.log('child-exiting')",
    ].join(";");
    const tool = createBashTool(dir);
    const started = Date.now();

    try {
      const result = await tool.execute({
        command: `node -e ${JSON.stringify(script)} ${JSON.stringify(pidFile)}`,
        timeout: 5,
      }, { cwd: dir });

      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("child-exiting");

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pid = Number(readFileSync(pidFile, "utf-8"));
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      cleanupPidFile(pidFile);
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("allows rm to execute when no approval controller is attached", async () => {
    const dir = join(tmpdir(), "bubble-bash-rm-file-" + Date.now());
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "snake.html");
    writeFileSync(file, "<html></html>", "utf-8");

    const tool = createBashTool(dir);
    const result = await tool.execute({ command: "rm snake.html" }, { cwd: dir });

    expect(result.isError).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupPidFile(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf-8"));
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

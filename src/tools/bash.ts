/**
 * Bash tool - execute shell commands with streaming capture.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

const MAX_OUTPUT = 50 * 1024;

export function createBashTool(cwd: string): ToolRegistryEntry {
  return {
    name: "bash",
    description:
      "Execute a bash command in the working directory. Use timeout for long-running commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
      },
      required: ["command"],
    },
    async execute(args): Promise<ToolResult> {
      if (!existsSync(cwd)) {
        return { content: `Error: Working directory does not exist: ${cwd}`, isError: true };
      }

      const command = String(args.command);
      const timeoutSec = typeof args.timeout === "number" ? args.timeout : 60;

      return new Promise((resolve) => {
        const shell = platform() === "win32" ? "cmd.exe" : "bash";
        const shellArgs = platform() === "win32" ? ["/c", command] : ["-c", command];

        const child = spawn(shell, shellArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000);
        }, timeoutSec * 1000);

        child.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        child.stderr?.on("data", (data) => {
          stderr += data.toString();
        });

        child.on("error", (err) => {
          clearTimeout(timeoutHandle);
          resolve({ content: `Error: ${err.message}`, isError: true });
        });

        child.on("close", (code) => {
          clearTimeout(timeoutHandle);

          let output = "";
          if (stdout) output += `stdout:\n${stdout}\n`;
          if (stderr) output += `stderr:\n${stderr}\n`;
          if (output === "") output = "(no output)\n";

          if (timedOut) {
            output += `[Command timed out after ${timeoutSec}s]`;
            resolve({ content: output.trim(), isError: true });
            return;
          }

          if (Buffer.byteLength(output, "utf-8") > MAX_OUTPUT) {
            output = Buffer.from(output, "utf-8").subarray(0, MAX_OUTPUT).toString("utf-8");
            output += "\n[Output truncated]";
          }

          const isError = code !== 0;
          resolve({ content: output.trim(), isError });
        });
      });
    },
  };
}

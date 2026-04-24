/**
 * Bash tool - execute shell commands with streaming capture.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { parseSearchBashCommand } from "../agent/tool-intent.js";
import { referencesSensitivePath } from "./sensitive-paths.js";

const MAX_OUTPUT = 50 * 1024;

export function createBashTool(cwd: string, approval?: ApprovalController): ToolRegistryEntry {
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
      const parsedSearch = parseSearchBashCommand(command);

      if (referencesSensitivePath(command)) {
        return {
          content: "Error: Bash access to sensitive credential storage is blocked.",
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            reason: "Sensitive credential storage is not accessible from general-purpose bash commands.",
          },
        };
      }

      const gate = await gateToolAction(approval, { type: "bash", command, cwd });
      if (!gate.approved) return gate.result;

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
            resolve({
              content: output.trim(),
              isError: true,
              status: "timeout",
              metadata: {
                kind: parsedSearch ? "search" : "shell",
                pattern: parsedSearch?.pattern,
                path: parsedSearch?.path,
              },
            });
            return;
          }

          if (Buffer.byteLength(output, "utf-8") > MAX_OUTPUT) {
            output = Buffer.from(output, "utf-8").subarray(0, MAX_OUTPUT).toString("utf-8");
            output += "\n[Output truncated]";
          }

          const normalizedOutput = output.trim();
          if (parsedSearch && code === 1 && !stderr.trim()) {
            resolve({
              content: normalizedOutput === "(no output)" ? "stdout:\n(no matches)" : normalizedOutput,
              isError: false,
              status: "no_match",
              metadata: {
                kind: "search",
                pattern: parsedSearch.pattern,
                path: parsedSearch.path,
                matches: 0,
              },
            });
            return;
          }

          const isError = code !== 0;
          resolve({
            content: normalizedOutput,
            isError,
            status: isError ? "command_error" : "success",
            metadata: {
              kind: parsedSearch ? "search" : "shell",
              pattern: parsedSearch?.pattern,
              path: parsedSearch?.path,
              matches: parsedSearch ? countSearchMatches(stdout) : undefined,
            },
          });
        });
      });
    },
  };
}

function countSearchMatches(stdout: string): number {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
}

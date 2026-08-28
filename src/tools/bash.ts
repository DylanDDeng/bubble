/**
 * Bash tool - execute shell commands with streaming capture.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { parseReadBashCommand, parseSearchBashCommand } from "../agent/tool-intent.js";
import { referencesSensitivePath } from "./sensitive-paths.js";
import type { FileStateTracker } from "./file-state.js";
import type { ProcessManager } from "../tasks/manager.js";
import type { PromotionChannel } from "../tasks/promotion.js";

const MAX_OUTPUT = 50 * 1024;
const POST_EXIT_STDIO_GRACE_MS = 150;
const FORCE_KILL_AFTER_MS = 750;
const ABORT_SETTLE_AFTER_MS = 1500;

// "promoted" (design §2.5): a Ctrl+B/automatic promotion resolves the tool call early
// while the process keeps running under the task manager — its finish path
// must NOT kill the process group or destroy the stdio streams.
type TerminalKind = "exit" | "error" | "timeout" | "cancelled" | "promoted";

export interface BashToolOptions {
  /**
   * Background tasks are a per-host capability (background-tasks design
   * §2.0): only the interactive TUI wires the manager AND enables the flag.
   * Print mode, feishu/desktop hosts, and worktree/workflow children leave
   * this off, so run_in_background is rejected there with a clear error.
   */
  processManager?: ProcessManager;
  allowBackgroundTasks?: boolean;
  /** Ctrl+B send-to-background requests, keyed by toolCall id (design §2.5). */
  promotionChannel?: PromotionChannel;
  /** Move a still-running foreground command into Tasks after this budget. */
  autoBackgroundAfterMs?: number | false;
}

export function createBashTool(
  cwd: string,
  approval?: ApprovalController,
  _fileState?: FileStateTracker,
  options: BashToolOptions = {},
): ToolRegistryEntry {
  const backgroundEnabled = options.allowBackgroundTasks === true && !!options.processManager;
  return {
    name: "bash",
    effect: "unknown",
    requiresApproval: true,
    description:
      "Execute a bounded bash command in the working directory. Use timeout for long-running commands. "
      + (backgroundEnabled
        ? "For long one-shot commands with a definite end (full test suites, release builds, downloads), pass run_in_background: true — the command keeps running while you continue working and you are notified when it finishes; never poll with foreground sleep. "
        : "")
      + "For persistent dev servers or watchers such as npm run dev, next dev, vite, or webpack --watch, use the managed server tools instead of backgrounding a bash command (deferred: load them first via tool_search with query 'select:start_server,server_status,server_logs,stop_server').",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        description: {
          type: "string",
          description: "One short sentence (5-10 words) describing what this command does, shown to the user in the UI. Write it in the same language the user is conversing in.",
        },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
        ...(backgroundEnabled
          ? {
              run_in_background: {
                type: "boolean",
                description: "Run as a background task: returns a task id immediately and the command keeps running while you continue. Only for long one-shot commands with a definite end; not for quick commands or persistent servers.",
              },
            }
          : {}),
      },
      required: ["command"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!existsSync(cwd)) {
        return { content: `Error: Working directory does not exist: ${cwd}`, isError: true };
      }

      const command = String(args.command);
      const timeoutSec = typeof args.timeout === "number" ? args.timeout : 60;
      const runInBackground = args.run_in_background === true;
      const parsedSearch = parseSearchBashCommand(command);
      const parsedRead = parsedSearch ? undefined : parseReadBashCommand(command);

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

      if (runInBackground && !backgroundEnabled) {
        return {
          content:
            "Error: run_in_background is unavailable in this session (non-interactive host or subagent). "
            + "Run the command in the foreground with an explicit timeout instead.",
          isError: true,
          status: "blocked",
          metadata: { kind: "shell", reason: "background_unavailable" },
        };
      }

      const gate = await gateToolAction(approval, {
        type: "bash",
        command,
        cwd,
        ...(runInBackground ? { background: true } : {}),
      });
      if (!gate.approved) return gate.result;

      if (runInBackground) {
        try {
          const task = options.processManager!.startTask({
            command,
            description: typeof args.description === "string" ? args.description : undefined,
            cwd: ctx.cwd || cwd,
            ownerSessionId: ctx.sessionID,
          });
          // Make the read/kill path available immediately — no tool_search hop
          // (design §2.1: programmatic unlock at first spawn).
          ctx.agent?.unlockDeferredTools?.(["task_output", "kill_task"]);
          return {
            content:
              `Started background task ${task.id}${task.description ? ` (${task.description})` : ""}. `
              + "It runs while you continue working; you will be notified when it finishes. "
              + "Use task_output to check on it, kill_task to stop it.",
            status: "success",
            metadata: { kind: "shell", command, taskId: task.id, background: true },
          };
        } catch (error: any) {
          return { content: `Error: ${error?.message ?? String(error)}`, isError: true };
        }
      }

      return new Promise((resolve) => {
        const shell = platform() === "win32" ? "cmd.exe" : "bash";
        const shellArgs = platform() === "win32" ? ["/c", command] : ["-c", command];
        const spawnedAt = Date.now();

        const child = spawn(shell, shellArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          detached: platform() !== "win32",
          windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        let promotedTaskId: string | undefined;
        let unregisterPromotion: (() => void) | undefined;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let stdoutEnded = child.stdout === null;
        let stderrEnded = child.stderr === null;
        let exitCode: number | null = null;
        let terminal: TerminalKind | undefined;
        let terminalError: Error | undefined;
        let resolved = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let autoBackgroundHandle: NodeJS.Timeout | undefined;
        let forceKillHandle: NodeJS.Timeout | undefined;
        let settleHandle: NodeJS.Timeout | undefined;
        let postExitHandle: NodeJS.Timeout | undefined;

        const appendOutput = (target: "stdout" | "stderr", data: Buffer) => {
          const current = target === "stdout" ? stdout : stderr;
          const truncated = target === "stdout" ? stdoutTruncated : stderrTruncated;
          if (truncated) return;

          const next = current + data.toString();
          if (Buffer.byteLength(next, "utf-8") <= MAX_OUTPUT) {
            if (target === "stdout") stdout = next;
            else stderr = next;
            return;
          }

          const capped = Buffer.from(next, "utf-8").subarray(0, MAX_OUTPUT).toString("utf-8");
          if (target === "stdout") {
            stdout = capped;
            stdoutTruncated = true;
          } else {
            stderr = capped;
            stderrTruncated = true;
          }
        };

        const buildOutput = (suffix?: string): string => {
          let output = "";
          if (stdout) output += `stdout:\n${stdout}\n`;
          if (stderr) output += `stderr:\n${stderr}\n`;
          if (output === "") output = "(no output)\n";
          if (stdoutTruncated || stderrTruncated) {
            output += "\n[Output truncated]";
          }

          if (Buffer.byteLength(output, "utf-8") > MAX_OUTPUT) {
            output = Buffer.from(output, "utf-8").subarray(0, MAX_OUTPUT).toString("utf-8");
            output += "\n[Output truncated]";
          }
          if (suffix) output += `${output.endsWith("\n") ? "" : "\n"}${suffix}`;
          return output.trim();
        };

        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (autoBackgroundHandle) clearTimeout(autoBackgroundHandle);
          if (forceKillHandle) clearTimeout(forceKillHandle);
          if (settleHandle) clearTimeout(settleHandle);
          if (postExitHandle) clearTimeout(postExitHandle);
          ctx.abortSignal?.removeEventListener("abort", abortChild);
          unregisterPromotion?.();
          child.stdout?.removeListener("data", onStdoutData);
          child.stderr?.removeListener("data", onStderrData);
          child.stdout?.removeListener("end", onStdoutEnd);
          child.stdout?.removeListener("close", onStdoutEnd);
          child.stderr?.removeListener("end", onStderrEnd);
          child.stderr?.removeListener("close", onStderrEnd);
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          child.removeListener("close", onClose);
        };

        const destroyStreams = () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        };

        const cleanupBackgroundGroup = () => {
          if (!child.pid || terminal !== "exit") return;
          killProcessTree(child.pid, "SIGTERM");
          setTimeout(() => killProcessTree(child.pid!, "SIGKILL"), FORCE_KILL_AFTER_MS).unref?.();
        };

        const finish = () => {
          if (resolved) return;
          resolved = true;
          cleanup();

          if (terminal === "promoted") {
            // Ctrl+B/automatic promotion (design §2.5): the process lives on under the
            // task manager — skip the group kill AND the stream destruction
            // (the manager attached its own data listeners in adoptTask).
            resolve({
              content: buildOutput(
                `[Moved to background: ${promotedTaskId}. The command keeps running; check it with task_output.]`,
              ),
              status: "success",
              metadata: { kind: "shell", command, taskId: promotedTaskId, background: true },
            });
            return;
          }

          cleanupBackgroundGroup();
          destroyStreams();

          if (terminal === "error") {
            resolve({ content: `Error: ${terminalError?.message ?? "Failed to start command"}`, isError: true });
            return;
          }

          if (terminal === "timeout") {
            resolve({
              content: buildOutput(`[Command timed out after ${timeoutSec}s]`),
              isError: true,
              status: "timeout",
              metadata: {
                kind: parsedSearch ? "search" : parsedRead ? "read" : "shell",
                pattern: parsedSearch?.pattern,
                path: parsedSearch?.path ?? parsedRead?.path,
              },
            });
            return;
          }

          if (terminal === "cancelled") {
            resolve({
              content: buildOutput("[Command cancelled]"),
              isError: true,
              status: "cancelled",
              metadata: {
                kind: parsedSearch ? "search" : parsedRead ? "read" : "shell",
                pattern: parsedSearch?.pattern,
                path: parsedSearch?.path ?? parsedRead?.path,
                reason: "cancelled",
              },
            });
            return;
          }

          const normalizedOutput = buildOutput();
          if (parsedSearch && exitCode === 1 && !stderr.trim()) {
            resolve({
              content: normalizedOutput === "(no output)" ? "stdout:\n(no matches)" : normalizedOutput,
              isError: false,
              status: "no_match",
              metadata: {
                kind: "search",
                pattern: parsedSearch.pattern,
                path: parsedSearch.path,
                command,
                matches: 0,
              },
            });
            return;
          }

          const isError = exitCode !== 0;
          resolve({
            content: normalizedOutput,
            isError,
            status: isError ? "command_error" : "success",
            metadata: {
              kind: parsedSearch ? "search" : parsedRead ? "read" : "shell",
              pattern: parsedSearch?.pattern,
              path: parsedSearch?.path ?? parsedRead?.path,
              command,
              matches: parsedSearch ? countSearchMatches(stdout) : undefined,
            },
          });
        };

        const maybeFinishAfterExit = () => {
          if (terminal !== "exit" && terminal !== "timeout" && terminal !== "cancelled") return;
          if (stdoutEnded && stderrEnded) {
            finish();
            return;
          }
          if (!postExitHandle) {
            postExitHandle = setTimeout(finish, POST_EXIT_STDIO_GRACE_MS);
          }
        };

        const abortChild = () => {
          if (resolved || terminal) return;
          terminal = "cancelled";
          if (child.pid) {
            killProcessTree(child.pid, "SIGTERM");
            forceKillHandle = setTimeout(() => {
              if (child.pid) killProcessTree(child.pid, "SIGKILL");
            }, FORCE_KILL_AFTER_MS);
          }
          settleHandle = setTimeout(finish, ABORT_SETTLE_AFTER_MS);
        };

        const timeoutChild = () => {
          if (resolved || terminal) return;
          terminal = "timeout";
          if (child.pid) {
            killProcessTree(child.pid, "SIGTERM");
            forceKillHandle = setTimeout(() => {
              if (child.pid) killProcessTree(child.pid, "SIGKILL");
            }, FORCE_KILL_AFTER_MS);
          }
          settleHandle = setTimeout(finish, ABORT_SETTLE_AFTER_MS);
        };

        const onStdoutData = (data: Buffer) => appendOutput("stdout", data);
        const onStderrData = (data: Buffer) => appendOutput("stderr", data);
        const onStdoutEnd = () => {
          stdoutEnded = true;
          maybeFinishAfterExit();
        };
        const onStderrEnd = () => {
          stderrEnded = true;
          maybeFinishAfterExit();
        };
        const onError = (err: Error) => {
          if (!terminal) {
            terminal = "error";
            terminalError = err;
          }
          finish();
        };
        const onExit = (code: number | null) => {
          exitCode = code;
          if (!terminal) terminal = "exit";
          maybeFinishAfterExit();
        };
        const onClose = (code: number | null) => {
          exitCode = code;
          if (!terminal) terminal = "exit";
          finish();
        };

        // Ctrl+B/automatic promotion (design §2.5): flag-flip into the task manager.
        // Registered only for background-capable hosts; a no-op once any
        // terminal state is set (benign race with exit/timeout/cancel).
        const promoteToBackground = (): string | undefined => {
          if (resolved || terminal) return undefined;
          if (!options.processManager) return undefined;
          try {
            const task = options.processManager.adoptTask({
              command,
              description: typeof args.description === "string" ? args.description : undefined,
              cwd: ctx.cwd || cwd,
              ownerSessionId: ctx.sessionID,
              child,
              outputSoFar: [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
                .filter(Boolean)
                .join(""),
              startedAt: spawnedAt,
            });
            promotedTaskId = task.id;
          } catch {
            // Task cap reached or adopt failed — keep running in the foreground.
            return undefined;
          }
          terminal = "promoted";
          ctx.agent?.unlockDeferredTools?.(["task_output", "kill_task"]);
          finish();
          return promotedTaskId;
        };
        if (backgroundEnabled && options.promotionChannel && ctx.toolCall?.id) {
          unregisterPromotion = options.promotionChannel.register(ctx.toolCall.id, promoteToBackground);
        }
        if (
          backgroundEnabled
          && options.autoBackgroundAfterMs !== false
          && typeof options.autoBackgroundAfterMs === "number"
          && options.autoBackgroundAfterMs > 0
          && options.autoBackgroundAfterMs < timeoutSec * 1000
        ) {
          autoBackgroundHandle = setTimeout(promoteToBackground, options.autoBackgroundAfterMs);
          autoBackgroundHandle.unref?.();
        }

        timeoutHandle = setTimeout(timeoutChild, timeoutSec * 1000);
        if (ctx.abortSignal?.aborted) abortChild();
        ctx.abortSignal?.addEventListener("abort", abortChild, { once: true });

        child.stdout?.on("data", onStdoutData);
        child.stderr?.on("data", onStderrData);
        child.stdout?.once("end", onStdoutEnd);
        child.stdout?.once("close", onStdoutEnd);
        child.stderr?.once("end", onStderrEnd);
        child.stderr?.once("close", onStderrEnd);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", onClose);
      });
    },
  };
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (platform() === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Process may already be gone or taskkill may be unavailable.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function countSearchMatches(stdout: string): number {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
}

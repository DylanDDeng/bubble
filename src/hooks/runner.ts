import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { HookEventEnvelope, HookRunnerResult, LoadedHookRule } from "./types.js";
import { truncateHookText } from "./types.js";

export interface HookRunnerOptions {
  abortSignal?: AbortSignal;
}

interface ParsedHookOutput {
  decision?: "allow" | "deny" | "block";
  reason?: string;
  modelContext?: string | string[];
  context?: string | string[];
  visibleToModel?: boolean;
  exposeToModel?: boolean;
}

const TERMINATE_GRACE_MS = 250;

export async function runHookCommand(
  rule: LoadedHookRule,
  envelope: HookEventEnvelope,
  options: HookRunnerOptions = {},
): Promise<HookRunnerResult> {
  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  return new Promise<HookRunnerResult>((resolve) => {
    const finish = (result: Omit<HookRunnerResult, "elapsedMs" | "stdout" | "stderr" | "truncated">) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        ...result,
        elapsedMs: Math.round(performance.now() - startedAt),
        stdout,
        stderr,
        truncated,
      });
    };

    const child = spawn(rule.command.command, rule.command.args ?? [], {
      cwd: rule.command.cwd ?? envelope.cwd,
      env: buildHookEnv(rule, envelope),
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const terminate = (signal: NodeJS.Signals = "SIGTERM") => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      }
    };

    const hardTerminateSoon = () => {
      setTimeout(() => terminate("SIGKILL"), TERMINATE_GRACE_MS).unref?.();
    };

    const abortListener = () => {
      terminate();
      hardTerminateSoon();
      finish({
        decision: rule.onError === "block" ? "deny" : "allow",
        reason: rule.onError === "block" ? "Hook aborted." : undefined,
        modelContext: [],
        error: "Hook aborted.",
      });
    };
    options.abortSignal?.addEventListener("abort", abortListener, { once: true });

    timeout = setTimeout(() => {
      terminate();
      hardTerminateSoon();
      finish({
        decision: rule.onError === "block" ? "deny" : "allow",
        reason: rule.onError === "block" ? `Hook timed out after ${rule.timeoutMs}ms.` : undefined,
        modelContext: [],
        error: `Hook timed out after ${rule.timeoutMs}ms.`,
      });
    }, rule.timeoutMs);

    child.on("error", (error) => {
      finish({
        decision: rule.onError === "block" ? "deny" : "allow",
        reason: rule.onError === "block" ? error.message : undefined,
        modelContext: [],
        error: error.message,
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      stdout += chunk.toString("utf-8");
      if (Buffer.byteLength(stdout, "utf-8") > rule.maxOutputBytes) {
        stdout = truncateByBytes(stdout, rule.maxOutputBytes);
        truncated = true;
        terminate();
        hardTerminateSoon();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf-8") > rule.maxOutputBytes) return;
      stderr += chunk.toString("utf-8");
      if (Buffer.byteLength(stderr, "utf-8") > rule.maxOutputBytes) {
        stderr = truncateByBytes(stderr, rule.maxOutputBytes);
        truncated = true;
      }
    });

    child.on("close", (exitCode, signal) => {
      options.abortSignal?.removeEventListener("abort", abortListener);
      const parsed = parseHookOutput(stdout);
      const parseError = stdout.trim() && !parsed ? "Hook stdout was not valid JSON." : undefined;
      const parsedContext = parsed ? extractModelContext(parsed, rule.exposeToModel) : [];
      const parsedDecision = parsed?.decision === "block" ? "deny" : parsed?.decision;
      const reason = typeof parsed?.reason === "string"
        ? parsed.reason
        : exitCode === 2
          ? firstNonEmpty(stderr, stdout, "Hook denied the event.")
          : undefined;

      if (truncated) {
        finish({
          decision: rule.onError === "block" ? "deny" : "allow",
          reason: rule.onError === "block" ? "Hook output exceeded the configured limit." : undefined,
          modelContext: [],
          exitCode,
          signal,
          error: "Hook output exceeded the configured limit.",
        });
        return;
      }

      if (parseError) {
        finish({
          decision: rule.onError === "block" ? "deny" : "allow",
          reason: rule.onError === "block" ? parseError : undefined,
          modelContext: [],
          exitCode,
          signal,
          error: parseError,
        });
        return;
      }

      if (exitCode === 2 || parsedDecision === "deny") {
        finish({
          decision: "deny",
          reason: reason ?? "Hook denied the event.",
          modelContext: parsedContext,
          exitCode,
          signal,
        });
        return;
      }

      if (exitCode && exitCode !== 0) {
        const error = firstNonEmpty(stderr, stdout, `Hook exited with code ${exitCode}.`);
        finish({
          decision: rule.onError === "block" ? "deny" : "allow",
          reason: rule.onError === "block" ? error : undefined,
          modelContext: parsedContext,
          exitCode,
          signal,
          error,
        });
        return;
      }

      finish({
        decision: "allow",
        reason,
        modelContext: parsedContext,
        exitCode,
        signal,
      });
    });

    child.stdin?.end(JSON.stringify(envelope));
  });
}

function buildHookEnv(rule: LoadedHookRule, envelope: HookEventEnvelope): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL"]) {
    if (process.env[key]) base[key] = process.env[key];
  }
  return {
    ...base,
    ...(rule.command.env ?? {}),
    BUBBLE_HOOK_DEPTH: "1",
    BUBBLE_HOOK_ID: rule.id,
    BUBBLE_HOOK_EVENT: envelope.eventName,
    BUBBLE_HOOK_EVENT_ID: envelope.eventId,
    BUBBLE_HOOK_CWD: envelope.cwd,
  };
}

function parseHookOutput(stdout: string): ParsedHookOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as ParsedHookOutput;
  } catch {
    return undefined;
  }
}

function extractModelContext(parsed: ParsedHookOutput, ruleExposeToModel: boolean): string[] {
  const visible = parsed.visibleToModel === true || parsed.exposeToModel === true || ruleExposeToModel;
  if (!visible) return [];
  const raw = parsed.modelContext ?? parsed.context;
  if (typeof raw === "string") return [truncateHookText(raw, 4000)];
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => truncateHookText(item, 4000))
      .slice(0, 8);
  }
  return [];
}

function truncateByBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf-8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf-8");
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return truncateHookText(trimmed, 1000);
  }
  return "";
}

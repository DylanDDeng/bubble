import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { GrokRuntimeError } from "./grok-errors.js";

export type GrokSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface GrokCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunGrokCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Login-only hook. Called once, and only with Bubble's strictly allowlisted xAI OAuth URL. */
  onOAuthAuthorizeUrl?: (url: string) => void;
  /** Keep login stdout inside the process boundary; callers only receive the trusted URL hook above. */
  discardStdout?: boolean;
}

export const defaultGrokSpawn: GrokSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { ...options, shell: false });

function appendBounded(chunks: Buffer[], chunk: Buffer, used: number, limit: number): number {
  if (used >= limit) return used;
  const remaining = limit - used;
  chunks.push(chunk.subarray(0, remaining));
  return used + Math.min(chunk.byteLength, remaining);
}

export function sanitizeGrokDiagnostic(input: string, maxLength = 2048): string {
  let value = input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/https:\/\/auth\.x\.ai\/oauth2\/authorize[^\s"'<>`]*/gi, "https://auth.x.ai/oauth2/authorize?[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\bxai-[A-Za-z0-9_-]+/gi, "xai-[redacted]")
    .replace(/([?&](?:access_token|refresh_token|token|api_key|key|secret|password)=)[^\s&#]+/gi, "$1[redacted]")
    .replace(/(["']?(?:access_token|refresh_token|id_token|token|api_key|secret|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[redacted]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)\s*=\s*[^\s]+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g, "[redacted-jwt]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
  if (value.length > maxLength) value = `${value.slice(0, maxLength)}…`;
  return value.trim();
}

const GROK_OAUTH_AUTHORIZE_PREFIX = "https://auth.x.ai/oauth2/authorize";

/**
 * Extract only the pinned xAI authorization endpoint. OAuth query values are
 * intentionally treated as opaque and are never copied into diagnostics.
 */
export function extractGrokOAuthAuthorizeUrl(input: string): string | undefined {
  let offset = 0;
  while (offset < input.length) {
    const start = input.indexOf(GROK_OAUTH_AUTHORIZE_PREFIX, offset);
    if (start < 0) return undefined;
    let end = start + GROK_OAUTH_AUTHORIZE_PREFIX.length;
    while (end < input.length) {
      const char = input[end]!;
      const code = char.charCodeAt(0);
      if (code <= 0x20 || code === 0x7f || char === '"' || char === "'" || char === "<" || char === ">" || char === "`") {
        break;
      }
      end += 1;
    }
    let candidate = input.slice(start, end);
    while (/[),.;\]}]$/.test(candidate)) candidate = candidate.slice(0, -1);
    try {
      const parsed = new URL(candidate);
      if (
        parsed.protocol === "https:"
        && parsed.hostname === "auth.x.ai"
        && parsed.port === ""
        && parsed.username === ""
        && parsed.password === ""
        && parsed.pathname === "/oauth2/authorize"
        && parsed.hash === ""
      ) {
        return parsed.toString();
      }
    } catch {
      // Keep scanning: a malformed lookalike must not suppress a later valid URL.
    }
    offset = start + GROK_OAUTH_AUTHORIZE_PREFIX.length;
  }
  return undefined;
}

export async function runGrokCommand(
  spawn: GrokSpawn,
  binary: string,
  args: readonly string[],
  options: RunGrokCommandOptions,
): Promise<GrokCommandResult> {
  return await new Promise<GrokCommandResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GrokRuntimeError("cancelled", "Grok command cancelled."));
      return;
    }
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxStdout = options.maxStdoutBytes ?? 512 * 1024;
    const maxStderr = options.maxStderrBytes ?? 8 * 1024;
    let stdoutBytes = 0;
    let stdoutStoredBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let oauthStdoutScanBuffer = "";
    let oauthStderrScanBuffer = "";
    let oauthUrlSeen = false;
    let oauthHandlerFailed = false;
    let childError: unknown;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      killTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const scanOAuthChunk = (source: "stdout" | "stderr", text: string) => {
      if (oauthUrlSeen || !options.onOAuthAuthorizeUrl) return;
      if (source === "stdout") {
        oauthStdoutScanBuffer = `${oauthStdoutScanBuffer}${text}`.slice(-64 * 1024);
      } else {
        oauthStderrScanBuffer = `${oauthStderrScanBuffer}${text}`.slice(-64 * 1024);
      }
      const url = extractGrokOAuthAuthorizeUrl(
        source === "stdout" ? oauthStdoutScanBuffer : oauthStderrScanBuffer,
      );
      if (!url) return;
      oauthUrlSeen = true;
      try {
        options.onOAuthAuthorizeUrl(url);
      } catch {
        oauthHandlerFailed = true;
        terminate();
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!stdoutOverflow && stdoutBytes + bytes.byteLength > maxStdout) {
        stdoutOverflow = true;
        terminate();
      }
      stdoutBytes += bytes.byteLength;
      if (!options.discardStdout) {
        stdoutStoredBytes = appendBounded(stdout, bytes, stdoutStoredBytes, maxStdout);
      }
      scanOAuthChunk("stdout", bytes.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes = appendBounded(stderr, bytes, stderrBytes, maxStderr);
      scanOAuthChunk("stderr", bytes.toString("utf8"));
    });
    child.once("error", (error) => {
      childError = error;
    });
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted || options.signal?.aborted) {
        reject(new GrokRuntimeError("cancelled", "Grok command cancelled."));
        return;
      }
      if (stdoutOverflow) {
        reject(new GrokRuntimeError("protocol_error", "Grok command output exceeded the safe capture limit."));
        return;
      }
      if (oauthHandlerFailed) {
        reject(new GrokRuntimeError("protocol_error", "Grok OAuth URL handling failed."));
        return;
      }
      if (childError) {
        reject(childError);
        return;
      }
      if (code === null) {
        reject(new GrokRuntimeError("process_crashed", `Grok runtime terminated by ${signal ?? "an unknown signal"}.`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: sanitizeGrokDiagnostic(Buffer.concat(stderr).toString("utf8")),
        code,
      });
    });
  });
}

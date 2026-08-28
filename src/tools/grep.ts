/**
 * Grep tool - bounded, streaming search using ripgrep.
 *
 * The limits in this file are model-context safety boundaries, not UI-only
 * truncation. We stop rg as soon as a global budget is filled so a repository
 * search can never materialize a multi-megabyte tool result in memory/history.
 */

import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ToolRegistryEntry, ToolResult, ToolResultMetadata } from "../types.js";
import { isSensitivePath } from "./sensitive-paths.js";
import { analyzeToolIntent } from "../agent/tool-intent.js";
import { resolveToolPath } from "./path-utils.js";

const DEFAULT_MATCH_LIMIT = 100;
const MAX_MATCH_LIMIT = 1_000;
const MAX_RENDERED_LINE_CODE_POINTS = 1_000;
const MAX_RESULT_BYTES = 40 * 1024;
const MAX_RAW_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_FILE_SIZE = "5M";
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const GREP_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 250;
const RESULT_NOTICE_RESERVE_BYTES = 1_024;

type StopReason = "match_limit" | "stdout_limit" | "stderr_limit" | "timeout" | "aborted";

interface GrepMatch {
  rendered: string;
  absolutePath?: string;
}

interface FormattedMatches {
  content: string;
  emittedMatches: GrepMatch[];
  byteTruncated: boolean;
}

export function createGrepTool(cwd: string): ToolRegistryEntry {
  return {
    name: "grep",
    readOnly: true,
    effect: "read",
    description: [
      "Search file contents using regex (via ripgrep).",
      `Returns at most ${DEFAULT_MATCH_LIMIT} matches by default (explicit limit is capped at ${MAX_MATCH_LIMIT}),`,
      `${MAX_RESULT_BYTES / 1024}KiB total, and ${MAX_RENDERED_LINE_CODE_POINTS} Unicode characters per rendered match.`,
      `Files larger than ${MAX_FILE_SIZE} are skipped. Narrow path/glob/pattern when a result is marked truncated.`,
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in (optional, default: cwd)" },
        glob: { type: "string", description: "Glob pattern to filter files (optional, e.g. '*.ts')" },
        limit: {
          type: "number",
          description: `Maximum matches to return (default ${DEFAULT_MATCH_LIMIT}, hard maximum ${MAX_MATCH_LIMIT})`,
        },
      },
      required: ["pattern"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const searchPath = args.path ? resolveToolPath(cwd, args.path) : cwd;
      const pattern = String(args.pattern);
      const matchLimit = normalizeMatchLimit(args.limit);
      const intent = analyzeToolIntent({
        name: "grep",
        parsedArgs: {
          pattern,
          path: args.path,
          glob: args.glob,
        },
      });

      if (isSensitivePath(searchPath)) {
        return {
          content: `Error: Search blocked for sensitive credential storage: ${searchPath}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            path: searchPath,
            pattern,
            searchSignature: intent.search?.signature,
            searchFamily: intent.search?.familyKey,
            reason: "Sensitive credential storage is not searchable from general-purpose tasks.",
          },
        };
      }

      const rgArgs = [
        "--json",
        "--line-number",
        "--color=never",
        "--max-columns",
        String(MAX_RENDERED_LINE_CODE_POINTS),
        "--max-columns-preview",
        "--max-filesize",
        MAX_FILE_SIZE,
      ];
      if (args.glob) rgArgs.push("--glob", String(args.glob));
      rgArgs.push("--", pattern, searchPath);

      return executeBoundedGrep({
        cwd,
        searchPath,
        pattern,
        rgArgs,
        matchLimit,
        abortSignal: ctx.abortSignal,
        baseMetadata: {
          kind: "search",
          path: searchPath,
          pattern,
          searchSignature: intent.search?.signature,
          searchFamily: intent.search?.familyKey,
          maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
        },
      });
    },
  };
}

function executeBoundedGrep(options: {
  cwd: string;
  searchPath: string;
  pattern: string;
  rgArgs: string[];
  matchLimit: number;
  abortSignal?: AbortSignal;
  baseMetadata: ToolResultMetadata;
}): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn("rg", options.rgArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    const matches: GrepMatch[] = [];
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = "";
    let stopReason: StopReason | undefined;
    let spawnError: Error | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const requestStop = (reason: StopReason) => {
      if (stopReason) return;
      stopReason = reason;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const processJsonLine = (line: string) => {
      if (!line.trim() || stopReason) return;
      try {
        const event = JSON.parse(line) as any;
        if (event.type !== "match") return;
        const rawPath = decodeRgField(event.data?.path);
        const lineNumber = event.data?.line_number;
        const rawText = decodeRgField(event.data?.lines, "[non-UTF-8 match bytes omitted]") ?? "";
        const displayPath = rawPath || "<non-UTF-8 path>";
        const normalizedText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
        const rendered = truncateCodePoints(
          `${displayPath}:${typeof lineNumber === "number" ? lineNumber : "?"}: ${normalizedText}`,
          MAX_RENDERED_LINE_CODE_POINTS,
        );
        matches.push({
          rendered,
          ...(rawPath ? { absolutePath: resolvePath(options.cwd, rawPath) } : {}),
        });
        // We stop at N rather than pretending we proved there are N+1 matches.
        // The notice says "limit reached / may be incomplete", which is honest
        // even for the exact-fit case and avoids continuing a huge tree walk.
        if (matches.length >= options.matchLimit) requestStop("match_limit");
      } catch {
        // A truncated/invalid JSON event is not useful to the model. Raw byte
        // accounting remains authoritative and will stop pathological lines.
      }
    };

    const processDecodedText = (text: string) => {
      stdoutBuffer += text;
      while (!stopReason) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        processJsonLine(line);
      }
    };

    child.stdout.on("data", (value: Buffer | string) => {
      if (stopReason) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = Math.max(0, MAX_RAW_STDOUT_BYTES - stdoutBytes);
      const accepted = chunk.subarray(0, remaining);
      stdoutBytes += accepted.length;
      if (accepted.length > 0) processDecodedText(decoder.write(accepted));
      if (accepted.length < chunk.length || stdoutBytes >= MAX_RAW_STDOUT_BYTES) {
        requestStop("stdout_limit");
      }
    });

    child.stdout.on("end", () => {
      if (stopReason) return;
      processDecodedText(decoder.end());
      if (stdoutBuffer) {
        processJsonLine(stdoutBuffer);
        stdoutBuffer = "";
      }
    });

    child.stderr.on("data", (value: Buffer | string) => {
      if (stopReason) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = Math.max(0, MAX_STDERR_BYTES - stderrBytes);
      const accepted = chunk.subarray(0, remaining);
      stderrBytes += accepted.length;
      if (accepted.length > 0) stderr += accepted.toString("utf8");
      if (accepted.length < chunk.length || stderrBytes >= MAX_STDERR_BYTES) {
        requestStop("stderr_limit");
      }
    });

    const timeout = setTimeout(() => requestStop("timeout"), GREP_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = () => requestStop("aborted");
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (options.abortSignal?.aborted) onAbort();

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);

      if (stopReason === "aborted") {
        resolve({
          content: "Search cancelled.",
          isError: true,
          status: "cancelled",
          metadata: { ...options.baseMetadata, matches: 0, truncated: false, paths: [] },
        });
        return;
      }

      if (spawnError) {
        resolve({
          content: `Error calling grep: ${spawnError.message}`,
          isError: true,
          status: "command_error",
          metadata: { ...options.baseMetadata, matches: 0, truncated: false, paths: [] },
        });
        return;
      }

      const naturalCommandError = !stopReason && code !== 0 && code !== 1;
      const stoppedWithoutMatches = !!stopReason && matches.length === 0;
      if (matches.length === 0 && !stoppedWithoutMatches && !naturalCommandError) {
        resolve({
          content: "No matches found.",
          status: "no_match",
          metadata: { ...options.baseMetadata, matches: 0, truncated: false, paths: [] },
        });
        return;
      }

      if (naturalCommandError && matches.length === 0) {
        resolve({
          content: `Error calling grep: ${stderr.trim() || `ripgrep exited with code ${code}`}`,
          isError: true,
          status: "command_error",
          metadata: { ...options.baseMetadata, matches: 0, truncated: false, paths: [] },
        });
        return;
      }

      const formatted = formatMatches(matches, options.matchLimit, stopReason, naturalCommandError ? stderr.trim() : "");
      const truncated = !!stopReason || formatted.byteTruncated || naturalCommandError;
      const paths = [...new Set(formatted.emittedMatches.flatMap((match) => match.absolutePath ? [match.absolutePath] : []))];
      resolve({
        content: formatted.content,
        ...(naturalCommandError && matches.length === 0 ? { isError: true } : {}),
        status: stopReason === "timeout" && matches.length === 0
          ? "timeout"
          : truncated
            ? "partial"
            : "success",
        metadata: {
          ...options.baseMetadata,
          matches: formatted.emittedMatches.length,
          collectedMatches: matches.length,
          truncated,
          truncationReason: stopReason ?? (formatted.byteTruncated ? "result_bytes" : naturalCommandError ? "command_error" : undefined),
          rawStdoutBytes: stdoutBytes,
          paths,
        },
      });
    });
  });
}

function formatMatches(
  matches: GrepMatch[],
  matchLimit: number,
  stopReason: StopReason | undefined,
  commandWarning: string,
): FormattedMatches {
  const emitted: GrepMatch[] = [];
  let bodyBytes = 0;
  const bodyBudget = MAX_RESULT_BYTES - RESULT_NOTICE_RESERVE_BYTES;

  for (const match of matches) {
    const lineBytes = Buffer.byteLength(match.rendered, "utf8") + (emitted.length > 0 ? 1 : 0);
    if (bodyBytes + lineBytes > bodyBudget) break;
    emitted.push(match);
    bodyBytes += lineBytes;
  }

  const byteTruncated = emitted.length < matches.length;
  const notices: string[] = [];
  if (stopReason === "match_limit") {
    notices.push(
      `Search stopped after reaching the global limit of ${matchLimit} matches; results may be incomplete. Narrow path/glob/pattern to continue.`,
    );
  } else if (stopReason === "stdout_limit") {
    notices.push(`Raw ripgrep output reached ${formatBytes(MAX_RAW_STDOUT_BYTES)}; results are incomplete. Narrow the search.`);
  } else if (stopReason === "stderr_limit") {
    notices.push(`ripgrep diagnostics reached ${formatBytes(MAX_STDERR_BYTES)}; results are incomplete.`);
  } else if (stopReason === "timeout") {
    notices.push(`Search timed out after ${GREP_TIMEOUT_MS / 1000}s; results are incomplete. Narrow the search.`);
  }
  if (byteTruncated) {
    notices.push(
      `Showing ${emitted.length} of ${matches.length} collected matches because tool output is capped at ${formatBytes(MAX_RESULT_BYTES)}.`,
    );
  }
  if (commandWarning) notices.push(`ripgrep also reported: ${truncateCodePoints(commandWarning, 300)}`);

  let content = emitted.map((match) => match.rendered).join("\n");
  if (notices.length > 0) content += `${content ? "\n" : ""}[${notices.join(" ")}]`;
  // The reserve above normally guarantees this. Keep an exact byte backstop so
  // future notice copy cannot accidentally violate the model-facing contract.
  if (Buffer.byteLength(content, "utf8") > MAX_RESULT_BYTES) {
    content = truncateUtf8Prefix(content, MAX_RESULT_BYTES);
  }

  return { content, emittedMatches: emitted, byteTruncated };
}

function normalizeMatchLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MATCH_LIMIT;
  return Math.min(MAX_MATCH_LIMIT, Math.max(1, Math.floor(value)));
}

function decodeRgField(value: unknown, invalidBytesFallback?: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { text?: unknown; bytes?: unknown };
  if (typeof record.text === "string") return record.text;
  if (typeof record.bytes === "string") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(record.bytes, "base64"));
    } catch {
      return invalidBytesFallback;
    }
  }
  return undefined;
}

function truncateCodePoints(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return value;
  const marker = "... [truncated]";
  return `${points.slice(0, Math.max(0, maxCodePoints - Array.from(marker).length)).join("")}${marker}`;
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024}KiB` : `${bytes} bytes`;
}

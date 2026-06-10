import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { getBubbleHome } from "./bubble-home.js";
import type { AgentEvent, Message, ToolResult } from "./types.js";

export interface DebugTraceContext {
  cwd?: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  renderer?: string;
  surface?: string;
}

export interface DebugTraceInfo {
  enabled: boolean;
  path?: string;
  runId?: string;
  rawEnabled: boolean;
}

const TRACE_VERSION = 1;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_RAW_MAX_BYTES = 256 * 1024;

let initialized = false;
let tracePath: string | undefined;
let runId: string | undefined;
let sequence = 0;
let startedAt = performance.now();
let baseContext: DebugTraceContext = {};
let defaultPruneDone = false;

export function isDebugTraceEnabled(): boolean {
  const value = process.env.BUBBLE_TRACE?.trim();
  if (!value) return false;
  return !FALSE_VALUES.has(value.toLowerCase());
}

export function isDebugTraceRawEnabled(): boolean {
  const value = process.env.BUBBLE_TRACE_RAW?.trim().toLowerCase();
  return !!value && !FALSE_VALUES.has(value);
}

export function configureDebugTrace(context: DebugTraceContext): DebugTraceInfo {
  baseContext = { ...baseContext, ...dropUndefined(context) };
  const path = ensureTracePath();
  if (!path) return { enabled: false, rawEnabled: isDebugTraceRawEnabled() };
  return {
    enabled: true,
    path,
    runId,
    rawEnabled: isDebugTraceRawEnabled(),
  };
}

export function getDebugTraceInfo(): DebugTraceInfo {
  const path = ensureTracePath();
  if (!path) return { enabled: false, rawEnabled: isDebugTraceRawEnabled() };
  return {
    enabled: true,
    path,
    runId,
    rawEnabled: isDebugTraceRawEnabled(),
  };
}

export function traceEvent(
  phase: string,
  detail?: Record<string, unknown>,
  context?: DebugTraceContext,
): void {
  const path = ensureTracePath();
  if (!path) return;

  const eventContext = {
    ...baseContext,
    ...dropUndefined(context ?? {}),
  };
  const line = {
    traceVersion: TRACE_VERSION,
    ts: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedAt),
    seq: ++sequence,
    runId,
    pid: process.pid,
    phase,
    ...eventContext,
    ...(detail ? { detail: sanitizeTraceValue(detail) } : {}),
  };

  try {
    appendFileSync(path, JSON.stringify(line) + "\n", "utf-8");
  } catch {
    // Debug tracing must never affect normal agent execution.
  }
}

export function summarizeTraceText(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return summarizeTraceValue(value);
  return summarizeString(value);
}

export function summarizeTraceValue(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null) return { type: "null" };
  if (typeof value === "string") return summarizeString(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return { type: typeof value, value };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      json: summarizeJson(value),
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value as Record<string, unknown>).slice(0, 32),
      json: summarizeJson(value),
    };
  }
  return { type: typeof value, value: String(value) };
}

export function summarizeTraceMessage(message: Message): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: summarizeTraceText(message.content),
      reasoning: summarizeTraceText(message.reasoning ?? ""),
      error: message.error,
      providerMetadata: summarizeAssistantProviderMetadata(message),
      toolCalls: message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: summarizeTraceText(call.arguments),
        argsCorrupt: call.argsCorrupt,
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: message.role,
      toolCallId: message.toolCallId,
      content: summarizeTraceText(message.content),
      isError: message.isError,
      metadata: message.metadata,
    };
  }
  if (message.role === "user") {
    return {
      role: message.role,
      content: summarizeTraceValue(message.content),
    };
  }
  return {
    role: message.role,
    kind: "kind" in message ? message.kind : undefined,
    content: summarizeTraceText(message.content),
  };
}

function summarizeAssistantProviderMetadata(message: Extract<Message, { role: "assistant" }>): Record<string, unknown> | undefined {
  const blocks = message.providerMetadata?.anthropic?.contentBlocks;
  if (!blocks || blocks.length === 0) return undefined;
  return {
    anthropic: {
      contentBlocks: blocks.length,
      thinkingBlocks: blocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking").length,
      signatureChars: blocks.reduce((sum, block) => sum + (typeof block.signature === "string" ? block.signature.length : 0), 0),
      types: blocks.map((block) => block.type).slice(0, 32),
    },
  };
}

export function summarizeTraceToolResult(result: ToolResult): Record<string, unknown> {
  return {
    content: summarizeTraceText(result.content),
    isError: result.isError,
    status: result.status,
    metadata: result.metadata,
  };
}

export function summarizeTraceError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: truncateString(error.stack ?? "", 4000),
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

export function summarizeAgentEventForTrace(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "text_delta":
    case "reasoning_delta":
      return { type: event.type, content: summarizeTraceText(event.content) };
    case "hook_start":
    case "hook_end":
    case "hook_error":
      return { ...event };
    case "tool_call_start":
      return { type: event.type, id: event.id, name: event.name };
    case "tool_call_delta":
      return {
        type: event.type,
        id: event.id,
        name: event.name,
        argumentsDelta: summarizeTraceText(event.argumentsDelta),
        arguments: summarizeTraceText(event.arguments),
      };
    case "tool_call_end":
      return {
        type: event.type,
        id: event.id,
        name: event.name,
        arguments: summarizeTraceText(event.arguments),
      };
    case "tool_start":
      return {
        type: event.type,
        id: event.id,
        name: event.name,
        args: summarizeTraceValue(event.args),
      };
    case "tool_update":
      return {
        type: event.type,
        id: event.id,
        name: event.name,
        update: summarizeTraceValue(event.update),
      };
    case "tool_end":
      return {
        type: event.type,
        id: event.id,
        name: event.name,
        result: summarizeTraceToolResult(event.result),
      };
    case "turn_end":
      return {
        type: event.type,
        usage: event.usage,
        willContinue: event.willContinue,
      };
    case "input_applied":
    case "input_rejected":
      return {
        ...event,
        content: summarizeTraceText(event.content),
      };
    case "todos_updated":
      return { type: event.type, count: event.todos.length };
    default:
      return { ...event };
  }
}

export function resetDebugTraceForTests(): void {
  initialized = false;
  tracePath = undefined;
  runId = undefined;
  sequence = 0;
  startedAt = performance.now();
  baseContext = {};
  defaultPruneDone = false;
}

function ensureTracePath(): string | undefined {
  if (!isDebugTraceEnabled()) return undefined;
  if (initialized) return tracePath;

  initialized = true;
  startedAt = performance.now();
  runId = resolveRunId();
  tracePath = resolveTracePath(runId);
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    pruneDefaultTraceDirs();
  } catch {
    // The write path may still fail later; tracing remains best-effort.
  }
  return tracePath;
}

function resolveRunId(): string {
  const explicit = process.env.BUBBLE_TRACE_RUN_ID?.trim();
  if (explicit) return sanitizeFileSegment(explicit);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `trace-${stamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function resolveTracePath(id: string): string {
  const explicitPath = process.env.BUBBLE_TRACE_PATH?.trim();
  if (explicitPath) return isAbsolute(explicitPath) ? explicitPath : join(process.cwd(), explicitPath);

  const value = process.env.BUBBLE_TRACE?.trim();
  if (value && !TRUE_VALUES.has(value.toLowerCase()) && !FALSE_VALUES.has(value.toLowerCase())) {
    return isAbsolute(value) ? value : join(process.cwd(), value);
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  return join(getBubbleHome(), "debug-runs", dateKey, `${id}.jsonl`);
}

function pruneDefaultTraceDirs(): void {
  if (defaultPruneDone || process.env.BUBBLE_TRACE_PATH?.trim()) return;
  defaultPruneDone = true;
  const maxAgeDays = Number(process.env.BUBBLE_TRACE_MAX_AGE_DAYS ?? DEFAULT_MAX_AGE_DAYS);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return;

  const root = join(getBubbleHome(), "debug-runs");
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(root, entry);
    try {
      const stat = statSync(path);
      if (stat.mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function summarizeString(value: string): Record<string, unknown> {
  const byteLength = Buffer.byteLength(value, "utf8");
  const summary: Record<string, unknown> = {
    type: "string",
    chars: value.length,
    bytes: byteLength,
    hash: hashString(value),
  };
  if (isDebugTraceRawEnabled()) {
    summary.raw = truncateRaw(value, byteLength);
  }
  return summary;
}

function summarizeJson(value: unknown): Record<string, unknown> {
  const json = safeJsonStringify(value);
  if (json === undefined) return { serializable: false };
  const byteLength = Buffer.byteLength(json, "utf8");
  const summary: Record<string, unknown> = {
    serializable: true,
    chars: json.length,
    bytes: byteLength,
    hash: hashString(json),
  };
  if (isDebugTraceRawEnabled()) {
    summary.raw = truncateRaw(json, byteLength);
  }
  return summary;
}

function sanitizeTraceValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = sanitizeTraceValue(item);
    }
    return out;
  }
  return String(value);
}

function truncateRaw(value: string, byteLength: number): string | { value: string; truncated: true; bytes: number } {
  const limit = Number(process.env.BUBBLE_TRACE_RAW_MAX_BYTES ?? DEFAULT_RAW_MAX_BYTES);
  if (!Number.isFinite(limit) || limit <= 0 || byteLength <= limit) return value;
  return {
    value: value.slice(0, Math.max(0, limit)),
    truncated: true,
    bytes: byteLength,
  };
}

function truncateString(value: string, maxChars: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) (out as Record<string, unknown>)[key] = item;
  }
  return out;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "trace";
}

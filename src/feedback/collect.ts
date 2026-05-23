import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../agent.js";
import type { AssistantMessage, Message, ToolCall } from "../types.js";
import { redact } from "./redact.js";
import type { FeedbackPayload, TranscriptMessage } from "./types.js";

const MAX_TRANSCRIPT_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_TRANSCRIPT_CHARS = 32_000;
const MAX_TOOL_ARG_CHARS = 80;

export interface CollectOptions {
  description: string;
  recentError?: string;
}

export function collectFeedback(agent: Agent, opts: CollectOptions): FeedbackPayload {
  const transcript = buildTranscript(agent.messages);
  return {
    description: redact(opts.description),
    version: readVersion(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    provider: agent.providerId || "unknown",
    model: agent.model || "unknown",
    transcript,
    recentError: opts.recentError ? redact(opts.recentError) : undefined,
    submittedAt: Date.now(),
    clientId: randomUUID(),
  };
}

function buildTranscript(messages: Message[]): TranscriptMessage[] {
  const candidates = messages
    .filter(
      (m): m is Extract<Message, { role: "user" | "assistant" }> =>
        m.role === "user" || m.role === "assistant",
    )
    .map((m) => ({ role: m.role, content: renderMessage(m) }))
    .filter((m) => m.content.length > 0);

  const tail = candidates.slice(-MAX_TRANSCRIPT_MESSAGES);

  const out: TranscriptMessage[] = [];
  let totalChars = 0;

  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    const text = redact(truncate(m.content, MAX_MESSAGE_CHARS));
    if (totalChars + text.length > MAX_TOTAL_TRANSCRIPT_CHARS) break;
    totalChars += text.length;
    out.unshift({ role: m.role, content: text });
  }

  return out;
}

function renderMessage(m: Extract<Message, { role: "user" | "assistant" }>): string {
  const text = stringifyContent(m).trim();
  if (m.role === "assistant") {
    const toolSummary = summarizeToolCalls((m as AssistantMessage).toolCalls);
    if (text && toolSummary) return `${text}\n\n${toolSummary}`;
    if (toolSummary) return toolSummary;
    return text;
  }
  return text;
}

function stringifyContent(m: { role: string; content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((part: any) => {
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "image_url") return "[image]";
        return "";
      })
      .join("\n");
  }
  return "";
}

function summarizeToolCalls(calls: ToolCall[] | undefined): string {
  if (!calls || calls.length === 0) return "";
  const parts = calls.map((c) => {
    const argSummary = summarizeArgs(c.arguments);
    return argSummary ? `${c.name}(${argSummary})` : c.name;
  });
  return `[used tools: ${parts.join(", ")}]`;
}

function summarizeArgs(rawJson: string): string {
  if (!rawJson) return "";
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .slice(0, 2)
      .map(([k, v]) => {
        const str = String(v);
        return `${k}=${str.length > MAX_TOOL_ARG_CHARS ? str.slice(0, MAX_TOOL_ARG_CHARS) + "…" : str}`;
      });
    return entries.join(", ");
  } catch {
    return "";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

let cachedVersion: string | undefined;

function readVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = fileURLToPath(import.meta.url);
    // From dist/feedback/collect.js → ../../package.json
    const pkgPath = join(dirname(here), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cachedVersion = pkg.version || "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

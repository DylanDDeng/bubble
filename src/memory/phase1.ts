import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionLogEntry } from "../session.js";
import { sanitizeInternalReminderBlocks } from "../agent/internal-reminder-sanitizer.js";
import { checkpointMessages } from "../context/checkpoint.js";
import { isCompactionSummaryMessage } from "../context/compact.js";
import type { Message, ThinkingLevel } from "../types.js";
import { MemoryDatabase } from "./db.js";
import { getBubbleHome } from "./paths.js";
import { buildStageOneMessages, parseJsonObject } from "./prompts.js";
import { classifyMemorySession } from "./session-policy.js";
import { clearGeneratedMemoryOutputs } from "./storage.js";
import { redactSecrets } from "./store.js";

export interface Phase1Options {
  cwd: string;
  complete: (
    messages: Message[],
    options?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel },
  ) => Promise<string>;
  model?: string;
  minEntries?: number;
  limit?: number;
  now?: Date;
}

export interface Phase1Result {
  scanned: number;
  claimed: number;
  succeeded: number;
  empty: number;
  failed: number;
  skipped: number;
  errors: string[];
}

const DEFAULT_MIN_ENTRIES = 4;
const DEFAULT_LIMIT = 24;
const MAX_TRANSCRIPT_CHARS = 70_000;
const MAX_CONTENT_CHARS = 3_000;
// Bump when the extraction input/selection contract changes, even if the archive does not.
const EXTRACTOR_VERSION = "checkpoint-segments-v1";

export async function runMemoryPhase1(options: Phase1Options): Promise<Phase1Result> {
  const result: Phase1Result = { scanned: 0, claimed: 0, succeeded: 0, empty: 0, failed: 0, skipped: 0, errors: [] };
  if (!options.model) {
    result.skipped++;
    result.errors.push("no active model");
    return result;
  }

  const db = new MemoryDatabase(options.cwd);
  try {
    const sessions = listEligibleSessionFiles(options.limit ?? DEFAULT_LIMIT);
    result.scanned = sessions.length;
    for (const sessionFile of sessions) {
      const source = classifyMemorySession(sessionFile);
      if (source.kind !== "native") {
        if (db.getStage1Output(sessionFile)) {
          // Clear before deleting the provenance row so interruption cannot
          // leave an unsafe generated artifact that looks source-less later.
          clearGeneratedMemoryOutputs(options.cwd);
          db.deleteStage1Output(sessionFile);
        }
        result.skipped++;
        continue;
      }
      if (db.getThreadMemoryMode(sessionFile) === "disabled") {
        result.skipped++;
        continue;
      }
      const session = source.session;
      const sessionCwd = session.getMetadata().cwd ?? options.cwd;
      const entries = session.getEntries();
      const entryCount = entries.length;
      if (countMeaningfulEntries(entries) < (options.minEntries ?? DEFAULT_MIN_ENTRIES)) {
        result.skipped++;
        continue;
      }
      const sourceUpdatedAt = statSync(sessionFile).mtime.toISOString();
      const existing = db.getStage1Output(sessionFile);
      if (existing && existing.extractorVersion === EXTRACTOR_VERSION
        && existing.entryCount === entryCount && existing.sourceUpdatedAt === sourceUpdatedAt) {
        result.skipped++;
        continue;
      }
      const claim = db.claimPhase1Job(sessionFile, randomUUID(), 3600);
      if (!claim.claimed) {
        result.skipped++;
        continue;
      }

      result.claimed++;
      try {
        const transcript = serializeSessionEntries(entries);
        const raw = await options.complete(buildStageOneMessages({
          cwd: sessionCwd,
          sessionFile,
          transcript,
        }), {
          model: options.model,
          temperature: 0,
          thinkingLevel: "off",
        });
        const parsed = parseJsonObject(raw);
        const rawMemory = stringField(parsed.raw_memory);
        const rolloutSummary = stringField(parsed.rollout_summary);
        if (!rawMemory && !rolloutSummary) {
          result.empty++;
          continue;
        }
        db.upsertStage1Output({
          sessionFile,
          cwd: sessionCwd,
          entryCount,
          sourceUpdatedAt,
          extractorVersion: EXTRACTOR_VERSION,
          generatedAt: (options.now ?? new Date()).toISOString(),
          rawMemory: redactSecrets(rawMemory || rolloutSummary).text,
          rolloutSummary: redactSecrets(rolloutSummary || rawMemory).text,
          rolloutSlug: stringField(parsed.rollout_slug) || undefined,
        });
        db.finishPhase1Job(sessionFile, true);
        result.succeeded++;
      } catch (error) {
        db.finishPhase1Job(sessionFile, false, error instanceof Error ? error.message : String(error));
        result.failed++;
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    db.close();
  }

  return result;
}

function listEligibleSessionFiles(limit: number): string[] {
  const dir = join(getBubbleHome(), "sessions");
  if (!existsSync(dir)) return [];
  return collectSessionFiles(dir)
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}

function collectSessionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSessionFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

interface TranscriptLine { text: string; summary?: boolean }

function serializeSessionEntries(entries: SessionLogEntry[]): string {
  // A checkpoint supersedes originals only within its /clear segment. Unlike
  // live context, durable memory must still consider completed pre-clear work.
  const segments: TranscriptLine[][] = [];
  let segment: TranscriptLine[] = [];
  for (const entry of entries) {
    if (entry.type === "marker" && entry.kind === "conversation_clear") {
      if (segment.length) segments.push(segment);
      segment = [];
    } else if (entry.type === "context_checkpoint") {
      const messages = checkpointMessages(entry.checkpoint);
      segment = messages.flatMap(serializeCheckpointMessage);
      if (entry.checkpoint.summary && !segment.some(line => line.summary)) {
        segment.unshift({ text: `[summary] ${cleanText(entry.checkpoint.summary, MAX_CONTENT_CHARS)}`, summary: true });
      }
    } else if (entry.type === "summary") {
      // Legacy summaries have the same superseding semantics as checkpoints.
      segment = [{ text: serializeSessionEntry(entry), summary: true }];
    } else {
      const text = serializeSessionEntry(entry);
      if (text) segment.push({ text });
    }
  }
  if (segment.length) segments.push(segment);

  // Give every clear segment a share so a long new conversation cannot erase
  // all prior durable evidence. Spend unused shares on the newest segments.
  const budgets = segments.map(() => Math.floor(MAX_TRANSCRIPT_CHARS / Math.max(1, segments.length)));
  const sizes = segments.map(lines => lines.reduce((total, line) => total + line.text.length + 1, 0) + 40);
  let spare = MAX_TRANSCRIPT_CHARS;
  for (let i = 0; i < budgets.length; i++) {
    budgets[i] = Math.min(budgets[i], sizes[i]);
    spare -= budgets[i];
  }
  for (let i = budgets.length - 1; i >= 0 && spare > 0; i--) {
    const extra = Math.min(spare, sizes[i] - budgets[i]);
    budgets[i] += extra;
    spare -= extra;
  }
  return segments.map((lines, i) => selectTranscriptLines(lines, budgets[i], i)).filter(Boolean).join("\n");
}

function selectTranscriptLines(lines: TranscriptLine[], budget: number, segment: number): string {
  const header = `[conversation segment ${segment + 1}]\n`;
  if (budget <= header.length + 1) return "";
  let remaining = budget - header.length - 1;
  if (lines.reduce((total, line) => total + line.text.length + 1, 0) <= remaining) {
    return header + lines.map(line => line.text).join("\n");
  }
  const selected = new Map<number, string>();
  // Reserve at most half for summaries, leaving room for retained and suffix
  // evidence (especially corrections/revocations). Emit in chronological order.
  let summaryBudget = Math.floor(remaining / 2);
  for (let i = lines.length - 1; i >= 0 && summaryBudget > 40; i--) {
    if (!lines[i].summary) continue;
    const text = truncate(lines[i].text, Math.min(summaryBudget, remaining) - 1);
    selected.set(i, text);
    remaining -= text.length + 1;
    summaryBudget -= text.length + 1;
  }
  for (let i = lines.length - 1; i >= 0 && remaining > 1; i--) {
    if (selected.has(i)) continue;
    if (lines[i].text.length >= remaining && remaining <= 40) break;
    const text = truncate(lines[i].text, remaining - 1);
    selected.set(i, text);
    remaining -= text.length + 1;
  }
  return header + [...selected].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n");
}

function serializeCheckpointMessage(message: Message): TranscriptLine[] {
  if (isCompactionSummaryMessage(message)) {
    // Projected summaries use an internal-context envelope, but unlike runtime
    // reminders its payload is durable. Unwrap only this recognized summary.
    const text = contentToText(message.content).trim()
      .replace(/^<bubble_internal_context\b[^>]*>\s*/, "")
      .replace(/\s*<\/bubble_internal_context>$/, "");
    return [{ text: `[summary] ${cleanText(text, MAX_CONTENT_CHARS)}`, summary: true }];
  }
  switch (message.role) {
    case "user":
      return textLine("user", contentToText(message.content), MAX_CONTENT_CHARS);
    case "assistant":
      return [
        ...textLine("assistant", message.content, MAX_CONTENT_CHARS),
        ...(message.toolCalls ?? []).flatMap(call => textLine(`tool_call:${call.name}`, call.arguments, 1_500)),
      ];
    case "tool":
      return textLine(`tool_result${message.isError ? " error=true" : ""}`, message.content, 2_000);
    case "system":
    case "meta":
      return []; // Host prompts and ephemeral runtime reminders are not memory.
  }
}

function textLine(label: string, content: string, limit: number): TranscriptLine[] {
  const text = cleanText(content, limit);
  return text.trim() ? [{ text: `[${label}] ${text}` }] : [];
}

function cleanText(content: string, limit: number): string {
  return truncate(sanitizeInternalReminderBlocks(content), limit);
}

function serializeSessionEntry(entry: SessionLogEntry): string {
  switch (entry.type) {
    case "metadata":
      return `[metadata] ${JSON.stringify(entry.metadata)}`;
    case "summary":
      return `[summary] ${cleanText(entry.summary, MAX_CONTENT_CHARS)}`;
    case "marker":
      return `[marker:${entry.kind}] ${cleanText(entry.value, MAX_CONTENT_CHARS)}`;
    case "user_message":
      return serializeCheckpointMessage(entry.message).map(line => line.text).join("\n");
    case "assistant_message":
      return textLine("assistant", entry.message.content, MAX_CONTENT_CHARS).map(line => line.text).join("\n");
    case "tool_call":
      return `[tool_call:${entry.toolCall.name}] ${cleanText(entry.toolCall.arguments, 1_500)}`;
    case "tool_result":
      return `[tool_result${entry.message.isError ? " error=true" : ""}] ${cleanText(entry.message.content, 2_000)}`;
    case "context_checkpoint":
      return ""; // Handled as a segment projection above.
    case "provider_error":
      // Operational diagnostics stay out of the memory-extraction prompt. The
      // structured session record remains available for local debugging.
      return "";
  }
}

function countMeaningfulEntries(entries: SessionLogEntry[]): number {
  return entries.filter((entry) =>
    entry.type === "user_message"
    || entry.type === "assistant_message"
    || entry.type === "tool_call"
    || entry.type === "tool_result"
    || entry.type === "summary"
  ).length;
}

function contentToText(content: Message["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 40).trimEnd()}\n[truncated ${value.length - maxChars + 40} chars]`;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

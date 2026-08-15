import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionLogEntry } from "../session.js";
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
      if (existing && existing.entryCount === entryCount && existing.sourceUpdatedAt === sourceUpdatedAt) {
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

function serializeSessionEntries(entries: SessionLogEntry[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (total >= MAX_TRANSCRIPT_CHARS) break;
    const line = serializeSessionEntry(entry);
    if (!line) continue;
    parts.push(line);
    total += line.length + 1;
  }
  return truncate(parts.join("\n"), MAX_TRANSCRIPT_CHARS);
}

function serializeSessionEntry(entry: SessionLogEntry): string {
  switch (entry.type) {
    case "metadata":
      return `[metadata] ${JSON.stringify(entry.metadata)}`;
    case "summary":
      return `[summary] ${truncate(entry.summary, MAX_CONTENT_CHARS)}`;
    case "marker":
      return `[marker:${entry.kind}] ${entry.value}`;
    case "user_message":
      return `[user] ${truncate(contentToText(entry.message.content), MAX_CONTENT_CHARS)}`;
    case "assistant_message":
      return `[assistant] ${truncate(entry.message.content, MAX_CONTENT_CHARS)}`;
    case "tool_call":
      return `[tool_call:${entry.toolCall.name}] ${truncate(entry.toolCall.arguments, 1_500)}`;
    case "tool_result":
      return `[tool_result${entry.message.isError ? " error=true" : ""}] ${truncate(entry.message.content, 2_000)}`;
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

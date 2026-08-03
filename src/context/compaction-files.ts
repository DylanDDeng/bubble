/**
 * Cumulative file-operation tracking across compactions.
 *
 * The LLM summary handles semantics (progress, decisions, next steps); which
 * files were touched is an enumerable fact the model reliably drops after a
 * couple of rolling summaries. So it never goes through the model: at each
 * compaction, deterministic code extracts file ops from the evicted messages,
 * unions them with the lists the previous summary carried, and appends the
 * result as structured blocks after the summary text.
 *
 * Robustness rules (each earned by a review finding):
 * - appendFileBlocks sanitizes its input first, so a summary can never carry
 *   two generations of blocks — or model-echoed tags — at once.
 * - Only tool calls with a successful result count: a rejected or failed edit
 *   must not report the file as modified.
 * - Lists are capped; modified entries are the ones worth keeping complete.
 * - Serialization is sorted and deduped so identical sets are identical bytes.
 */

import type { Message } from "../types.js";

export interface CompactionFileOps {
  read: string[];
  modified: string[];
}

const READ_TOOLS = new Set(["read"]);
const MODIFY_TOOLS = new Set(["edit", "write"]);

/** Cap per list. Modified is the higher-value list; both stay bounded. */
const MAX_FILES_PER_LIST = 200;
const MORE_MARKER = /^\(\+\d+ more\)$/;

const READ_BLOCKS = /<read-files>[\s\S]*?<\/read-files>/g;
const MODIFIED_BLOCKS = /<modified-files>[\s\S]*?<\/modified-files>/g;
/** Stray (unpaired / model-echoed) tags left after full blocks are removed. */
const STRAY_TAGS = /<\/?(?:read|modified)-files>/g;

/**
 * File ops mentioned by tool calls in the given (about-to-be-evicted)
 * messages. A call only counts when its tool result is present and not an
 * error — a rejected edit or failed read must not enter the record.
 */
export function extractFileOps(messages: Message[]): CompactionFileOps {
  const succeeded = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && !message.isError) succeeded.add(message.toolCallId);
  }
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      if (!succeeded.has(toolCall.id)) continue;
      const target = READ_TOOLS.has(toolCall.name)
        ? read
        : MODIFY_TOOLS.has(toolCall.name)
          ? modified
          : undefined;
      if (!target) continue;
      const path = pathFromArguments(toolCall.arguments);
      if (path) target.add(path);
    }
  }
  return { read: [...read], modified: [...modified] };
}

/** Parse every block a previous compaction summary carried (empty when absent). */
export function parseFileBlocks(text: string): CompactionFileOps {
  return {
    read: parseBlocks(text, READ_BLOCKS, "<read-files>", "</read-files>"),
    modified: parseBlocks(text, MODIFIED_BLOCKS, "<modified-files>", "</modified-files>"),
  };
}

/**
 * Remove all blocks AND stray tags, e.g. before feeding a prior summary back
 * to the model. Whitespace is only reflowed when something was removed.
 */
export function stripFileBlocks(text: string): string {
  const without = text.replace(READ_BLOCKS, "").replace(MODIFIED_BLOCKS, "").replace(STRAY_TAGS, "");
  if (without === text) return text;
  return without.replace(/\n{3,}/g, "\n\n").trim();
}

/** Union, deduped and sorted; a file that was ever modified never lists as read-only. */
export function mergeFileOps(...ops: CompactionFileOps[]): CompactionFileOps {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const op of ops) {
    for (const path of op.modified) modified.add(normalizePath(path));
    for (const path of op.read) read.add(normalizePath(path));
  }
  for (const path of modified) read.delete(path);
  return { read: [...read].sort(), modified: [...modified].sort() };
}

/**
 * Append the blocks to a summary text. Sanitizes the summary first so the
 * output always contains exactly one generation of blocks, even when the
 * model echoed tags into its own prose. No-op when both lists are empty.
 */
export function appendFileBlocks(summary: string, ops: CompactionFileOps): string {
  const clean = stripFileBlocks(summary);
  const blocks: string[] = [];
  if (ops.read.length > 0) blocks.push(`<read-files>\n${capped(ops.read)}\n</read-files>`);
  if (ops.modified.length > 0) blocks.push(`<modified-files>\n${capped(ops.modified)}\n</modified-files>`);
  if (blocks.length === 0) return clean;
  return `${clean.trimEnd()}\n\n${blocks.join("\n")}`;
}

function capped(paths: string[]): string {
  if (paths.length <= MAX_FILES_PER_LIST) return paths.join("\n");
  const kept = paths.slice(0, MAX_FILES_PER_LIST);
  return `${kept.join("\n")}\n(+${paths.length - MAX_FILES_PER_LIST} more)`;
}

function parseBlocks(text: string, pattern: RegExp, open: string, close: string): string[] {
  const out = new Set<string>();
  for (const match of text.match(pattern) ?? []) {
    const inner = match.slice(open.length, match.length - close.length);
    for (const line of inner.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !MORE_MARKER.test(trimmed)) out.add(trimmed);
    }
  }
  return [...out];
}

/**
 * Best-effort normalization so "./src/a.ts" and "src/a.ts" dedupe. Relative vs
 * absolute spellings of the same file can still coexist — resolving that needs
 * a cwd this layer doesn't have; models are consistent enough within a session
 * that the union stays useful.
 */
function normalizePath(path: string): string {
  let out = path.trim().replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function pathFromArguments(rawArguments: string | undefined): string | undefined {
  if (!rawArguments) return undefined;
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>;
    return typeof parsed.path === "string" && parsed.path.trim() ? parsed.path.trim() : undefined;
  } catch {
    return undefined;
  }
}

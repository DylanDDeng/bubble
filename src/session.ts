/**
 * Session Manager - Append-only JSONL persistence over a structured session log.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getBubbleHome } from "./bubble-home.js";
import { CheckpointStore } from "./checkpoints.js";
import { compactSessionEntries, type CompactOptions, type CompactResult } from "./context/compact.js";
import type { Message, Todo } from "./types.js";
import { SessionLog } from "./session-log.js";
import type { SessionLogEntry, SessionMarkerKind, SessionMetadata } from "./session-types.js";
import { normalizeSingleLine, truncateVisual } from "./text-display.js";
import { deterministicTitleFromUserContent } from "./session-title.js";

export interface SessionSummary {
  file: string;
  name: string;
  cwd?: string;
  cwdLabel: string;
  title: string;
  preview: string;
  firstUserMessage: string;
  messageCount: number;
  mtime: number;
}

export type { SessionLogEntry, SessionMarkerKind, SessionMetadata } from "./session-types.js";

export interface UserTurn {
  /** Session log entry id of the user message that starts the turn. */
  id: string;
  /** Single-line preview of the user message. */
  preview: string;
  /** Full text of the user message. */
  text: string;
  timestamp: number;
}

export interface RewindResult {
  /** Number of log entries removed. */
  removedEntries: number;
  /** Full text of the user message the session was rewound to (for re-editing). */
  targetText: string;
}

const AUTO_COMPACT_ENTRY_THRESHOLD = 180;
const AUTO_COMPACT_KEEP_RECENT_TURNS = 3;

export class SessionManager {
  private sessionFile: string;
  private log = new SessionLog();
  private checkpoints?: CheckpointStore;

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
    if (existsSync(sessionFile)) {
      this.load();
    }
  }

  static create(cwd: string, sessionName?: string): SessionManager {
    const file = resolveSessionFile(cwd, sessionName || `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    return new SessionManager(file);
  }

  static resume(cwd: string, sessionName?: string): SessionManager | undefined {
    if (sessionName) {
      const file = resolveSessionFile(cwd, sessionName);
      return existsSync(file) ? new SessionManager(file) : undefined;
    }

    const latest = this.listSessions(cwd).sort().at(-1);
    if (!latest) {
      return undefined;
    }

    return new SessionManager(resolveSessionFile(cwd, latest));
  }

  static createFresh(cwd: string): SessionManager {
    const file = resolveSessionFile(cwd, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    return new SessionManager(file);
  }

  static listSessions(cwd: string): string[] {
    const sessionsDir = getSessionsDir(cwd);
    if (!existsSync(sessionsDir)) return [];
    return readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"));
  }

  static summarizeSessionsForCwd(cwd: string): SessionSummary[] {
    const dir = getSessionsDir(cwd);
    if (!existsSync(dir)) return [];
    const summaries: SessionSummary[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const summary = summarizeSessionFile(join(dir, file), basename(dir));
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => b.mtime - a.mtime);
  }

  static listAllSessions(): SessionSummary[] {
    const root = join(getBubbleHome(), "sessions");
    if (!existsSync(root)) return [];
    const summaries: SessionSummary[] = [];
    for (const cwdDir of readdirSync(root)) {
      const dir = join(root, cwdDir);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const summary = summarizeSessionFile(join(dir, file), cwdDir);
        if (summary) summaries.push(summary);
      }
    }
    return summaries.sort((a, b) => b.mtime - a.mtime);
  }

  private load() {
    const content = readFileSync(this.sessionFile, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    this.log.load(lines);
  }

  private persist(entry: SessionLogEntry | SessionLogEntry[]) {
    const dir = dirname(this.sessionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const entries = Array.isArray(entry) ? entry : [entry];
    if (entries.length === 0) {
      return;
    }

    appendFileSync(this.sessionFile, entries.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }

  private rewrite(entries: SessionLogEntry[]) {
    const dir = dirname(this.sessionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    this.log.replace(entries);
  }

  getMetadata(): SessionMetadata {
    return this.log.getMetadata();
  }

  getOrCreatePromptCacheKey(): string {
    const existing = this.log.getMetadata().promptCacheKey;
    if (existing) return existing;

    const promptCacheKey = randomUUID();
    this.updateMetadata({ promptCacheKey });
    return promptCacheKey;
  }

  setMetadata(metadata: SessionMetadata) {
    const nextEntries = this.log.setMetadata(metadata);
    this.rewrite(nextEntries);
  }

  updateMetadata(patch: Partial<SessionMetadata>) {
    this.setMetadata({
      ...this.log.getMetadata(),
      ...dropUndefined(patch),
    });
  }

  clearTitleMetadata() {
    const {
      title: _title,
      titleSource: _titleSource,
      titleUpdatedAt: _titleUpdatedAt,
      titleUserMessageId: _titleUserMessageId,
      ...metadata
    } = this.log.getMetadata();
    this.setMetadata(metadata);
  }

  appendMessage(message: Message) {
    const entries = this.log.appendMessage(message);
    this.persist(entries);
    this.maybeAutoCompact();
  }

  appendCompaction(summary: string) {
    const entry = this.log.appendSummary(summary);
    this.persist(entry);
  }

  appendMarker(kind: SessionMarkerKind, value: string) {
    const entry = this.log.appendMarker(kind, value);
    this.persist(entry);
  }

  appendTodosSnapshot(todos: Todo[]) {
    const entry = this.log.appendTodosSnapshot(todos);
    this.persist(entry);
    this.maybeAutoCompact();
  }

  getTodos(): Todo[] {
    return this.log.getTodos();
  }

  compact(options?: CompactOptions): CompactResult {
    const result = compactSessionEntries(this.log.list(), options);
    if (result.compacted && result.entries) {
      this.rewrite(result.entries);
    }
    return result;
  }

  getMessages(): Message[] {
    return this.log.toMessages();
  }

  /**
   * Pre-edit file snapshot store for this session, used by /rewind.
   * Lives next to the session JSONL as `<session>.checkpoints/`.
   */
  getCheckpoints(): CheckpointStore {
    if (!this.checkpoints) {
      this.checkpoints = new CheckpointStore(
        this.sessionFile.replace(/\.jsonl$/, "") + ".checkpoints",
        () => this.lastUserEntryId(),
      );
    }
    return this.checkpoints;
  }

  /** Entry id of the most recent user message, or "0" before the first one. */
  lastUserEntryId(): string {
    const entries = this.log.list();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "user_message") return entry.id;
    }
    return "0";
  }

  /** User messages after the latest /clear, oldest first — the valid rewind anchors. */
  listUserTurns(): UserTurn[] {
    const entries = this.log.list();
    let start = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "marker" && entry.kind === "conversation_clear") {
        start = i + 1;
        break;
      }
    }

    const turns: UserTurn[] = [];
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type !== "user_message") continue;
      const text = messageText(entry.message);
      turns.push({
        id: entry.id,
        text,
        preview: truncateVisual(normalizeSingleLine(text), 80) || "(empty message)",
        timestamp: entry.timestamp,
      });
    }
    return turns;
  }

  /**
   * Truncate the session to just before the user message with the given
   * entry id. Returns undefined when the id does not name a user message.
   */
  rewindToEntry(entryId: string): RewindResult | undefined {
    const entries = this.log.list();
    const index = entries.findIndex((entry) => entry.id === entryId && entry.type === "user_message");
    if (index < 0) return undefined;

    const target = entries[index];
    const removed = entries.slice(index);
    this.rewrite(entries.slice(0, index));

    const metadata = this.log.getMetadata();
    if (metadata.titleUserMessageId && removed.some((entry) => entry.id === metadata.titleUserMessageId)) {
      this.clearTitleMetadata();
    }

    return {
      removedEntries: removed.length,
      targetText: target.type === "user_message" ? messageText(target.message) : "",
    };
  }

  getEntries(): SessionLogEntry[] {
    return this.log.list();
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  private maybeAutoCompact() {
    const entries = this.log.list();
    if (entries.length < AUTO_COMPACT_ENTRY_THRESHOLD) {
      return;
    }

    const result = compactSessionEntries(entries, {
      keepRecentTurns: AUTO_COMPACT_KEEP_RECENT_TURNS,
    });
    if (result.compacted && result.entries) {
      this.rewrite(result.entries);
    }
  }
}

export function getSessionsDir(cwd: string): string {
  const agentDir = getBubbleHome();
  const safeCwd = cwd.replace(/[/\\:]/g, "_");
  const sessionsDir = join(agentDir, "sessions", safeCwd);
  mkdirSync(sessionsDir, { recursive: true });
  return sessionsDir;
}

function resolveSessionFile(cwd: string, sessionName: string): string {
  return join(getSessionsDir(cwd), sessionName);
}

function summarizeSessionFile(file: string, cwdDir: string): SessionSummary | undefined {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return undefined;
  }
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return undefined;

  const log = new SessionLog();
  log.load(lines);
  const metadata = log.getMetadata();
  const entries = log.list();
  const messages = log.toMessages();

  const firstUserEntry = firstUserEntryAfterLatestClear(entries);
  const firstUserText = firstUserEntry ? messageText(firstUserEntry.message) : "";
  const preview = firstUserText
    ? sessionPreviewFromText(firstUserText)
    : (messages.length > 0 ? "No user message" : "No messages");
  const title = usableStoredTitle(metadata, entries)
    ?? (firstUserEntry ? deterministicTitleFromUserContent(firstUserEntry.message.content) : (messages.length > 0 ? "Assistant-only session" : "Empty session"));

  return {
    file,
    name: basename(file).replace(/\.jsonl$/, ""),
    cwd: metadata.cwd,
    cwdLabel: metadata.cwd ?? decodeCwdDir(cwdDir),
    title,
    preview,
    firstUserMessage: preview,
    messageCount: messages.length,
    mtime: stat.mtimeMs,
  };
}

function decodeCwdDir(safe: string): string {
  // safeCwd is cwd.replace(/[/\\:]/g, "_") — not perfectly reversible because we
  // can't tell underscores apart from path separators. For typical absolute
  // Unix paths this still produces a readable approximation.
  if (safe.startsWith("_")) return "/" + safe.slice(1).replace(/_/g, "/");
  return safe.replace(/_/g, "/");
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function firstUserEntryAfterLatestClear(entries: SessionLogEntry[]) {
  const startIndex = latestClearIndex(entries) + 1;
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "user_message") return entry;
  }
  return undefined;
}

function latestClearIndex(entries: SessionLogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "marker" && entry.kind === "conversation_clear") return i;
  }
  return -1;
}

function usableStoredTitle(metadata: SessionMetadata, entries: SessionLogEntry[]): string | undefined {
  const title = normalizeSingleLine(metadata.title ?? "");
  if (!title) return undefined;
  if (!metadata.titleUserMessageId) return title;

  const anchorIndex = entries.findIndex((entry) => entry.id === metadata.titleUserMessageId);
  if (anchorIndex < 0) return undefined;
  if (anchorIndex <= latestClearIndex(entries)) return undefined;
  return title;
}

function messageText(message: Message): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

function sessionPreviewFromText(text: string): string {
  return truncateVisual(normalizeSingleLine(text), 100) || "No user message";
}

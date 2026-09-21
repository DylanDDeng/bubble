/**
 * Session Manager - Append-only JSONL persistence over a structured session log.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, ftruncateSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isInternalBlockOnlyContent } from "./agent/internal-reminder-sanitizer.js";
import { getBubbleHome } from "./bubble-home.js";
import { CheckpointStore } from "./checkpoints.js";
import { withSessionWriteLock } from "./context/session-write-lock.js";
import {
  compactMessages,
  compactCurrentTurnToolGroups,
  buildCompactionSummaryMessage,
  isCompactionSummaryMessage,
  type CompactOptions,
  type CompactResult,
} from "./context/compact.js";
import type { Message } from "./types.js";
import { createContextCheckpoint, checkpointMessages, type ContextCheckpoint } from "./context/checkpoint.js";
import { SessionLog, affectsContextRevision } from "./session-log.js";
import type { SessionLogEntry, SessionMarkerKind, SessionMetadata } from "./session-types.js";
import type { SanitizedProviderError } from "./provider-error-record.js";
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

/** A fenced write found the session log diverged from the writer's resident
 * snapshot — a foreign append, clear, or rewind landed while a turn was in
 * flight. The write is refused; the host must roll its resident history back
 * to the file's truth (SessionContextFence.reloadHistory, then replace the
 * agent's messages) before writing again, or every later fenced write keeps
 * rejecting on the stale revision. */
export class SessionHistoryDivergedError extends Error {
  constructor(message = "Session changed during active turn; reload before committing context") {
    super(message);
    this.name = "SessionHistoryDivergedError";
  }
}

export interface RewindResult {
  /** Number of log entries removed. */
  removedEntries: number;
  /** Full text of the user message the session was rewound to (for re-editing). */
  targetText: string;
}

export class SessionManager {
  private sessionFile: string;
  private log = new SessionLog();
  private checkpoints?: CheckpointStore;
  private diskRevision = "missing";
  private pendingCompaction?: { revision: string; candidate: CompactResult };

  /** Conversational revision excludes metadata-only writes (for example titles). */
  getRevision(): string { return this.log.getRevision(); }

  private refresh(): void {
    if (this.currentDiskRevision() !== this.diskRevision) this.load();
  }

  private currentDiskRevision(): string {
    try { const s = statSync(this.sessionFile, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  }

  private withWriteLock<T>(write: () => T, expectedRevision?: string): T {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    return withSessionWriteLock(`${this.sessionFile}.write-lock`, () => {
      if (expectedRevision !== undefined) {
        // Refresh and compare the caller's snapshot under the same lock as the
        // append. Refreshing must never legitimize a stale caller revision.
        this.refresh();
        if (this.getRevision() !== expectedRevision) throw new SessionHistoryDivergedError();
      } else if (this.currentDiskRevision() !== this.diskRevision) {
        throw new SessionHistoryDivergedError("Session changed; reload before committing context");
      }
      return write();
    });
  }
  private readonly metadataListeners = new Set<(metadata: SessionMetadata) => void>();
  private readonly contextListeners = new Set<(previous: string, revision: string, replacement: boolean) => void>();

  /** Local commits only: disk refreshes must never advance a host's history fence. */
  subscribeContextCommits(listener: (previous: string, revision: string, replacement: boolean) => void): () => void {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  private publishContextCommit(previous: string, replacement = false): void {
    for (const listener of this.contextListeners) listener(previous, this.getRevision(), replacement);
  }

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
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = this.currentDiskRevision();
      const content = readFileSync(this.sessionFile, "utf-8");
      const after = this.currentDiskRevision();
      if (before !== after) continue;
      this.log.load(content.split("\n").filter(line => line.trim() !== ""));
      this.diskRevision = after;
      return;
    }
    throw new Error("Session changed while loading; retry with a stable snapshot");
  }

  private persist(entry: SessionLogEntry | SessionLogEntry[], lockHeld = false) {
    const dir = dirname(this.sessionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const entries = Array.isArray(entry) ? entry : [entry];
    if (entries.length === 0) {
      return;
    }

    const write = () => {
      const fd = openSync(this.sessionFile, "a+");
      const before = statSync(this.sessionFile).size;
      try {
        // Isolate an incomplete crash tail, without adding empty records normally.
        const tail = Buffer.alloc(1);
        if (before > 0) readSync(fd, tail, 0, 1, before - 1);
        const separator = before > 0 && tail[0] !== 10 ? "\n" : "";
        appendFileSync(fd, separator + entries.map((item) => JSON.stringify(item)).join("\n") + "\n");
        fsyncSync(fd);
      } catch (error) {
        ftruncateSync(fd, before);
        fsyncSync(fd);
        throw error;
      } finally { closeSync(fd); this.diskRevision = this.currentDiskRevision(); }
    };
    if (lockHeld) write();
    else this.withWriteLock(write);
  }

  /** Refresh, derive the replacement from the refreshed log, and swap the file
   * as one locked transaction; `derive` returning undefined leaves it untouched. */
  private rewrite<T>(derive: (entries: SessionLogEntry[]) => { entries: SessionLogEntry[]; result: T } | undefined): T | undefined {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    return withSessionWriteLock(`${this.sessionFile}.write-lock`, () => {
      this.refresh();
      const derived = derive(this.log.list());
      if (!derived) return undefined;
      const temp = `${this.sessionFile}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, derived.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
        const fd = openSync(temp, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, this.sessionFile);
        this.diskRevision = this.currentDiskRevision();
        this.log.replace(derived.entries);
      } finally { if (existsSync(temp)) unlinkSync(temp); }
      return derived.result;
    });
  }

  getMetadata(): SessionMetadata {
    return this.log.getMetadata();
  }

  /**
   * Subscribe to committed metadata changes (title, model, goal, runtime, ...).
   * Renderers use this instead of polling the session file, so async title
   * generation and runtime switches update fixed UI surfaces immediately.
   */
  subscribeMetadata(listener: (metadata: SessionMetadata) => void): () => void {
    this.metadataListeners.add(listener);
    return () => this.metadataListeners.delete(listener);
  }

  getOrCreatePromptCacheKey(): string {
    const existing = this.log.getMetadata().promptCacheKey;
    if (existing) return existing;

    const promptCacheKey = randomUUID();
    this.updateMetadata({ promptCacheKey });
    return promptCacheKey;
  }

  setMetadata(metadata: SessionMetadata) {
    this.mutateMetadata(() => metadata);
  }

  /** Refresh, derive, and append as one locked transaction. Metadata records
   * are full snapshots, so a snapshot built outside the lock would silently
   * overwrite a concurrent writer's fields. */
  mutateMetadata(build: (current: SessionMetadata) => SessionMetadata) {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    try {
      withSessionWriteLock(`${this.sessionFile}.write-lock`, () => {
        this.refresh();
        const entry: SessionLogEntry = { id: `metadata-${randomUUID()}`, type: "metadata",
          metadata: build(this.log.getMetadata()), timestamp: Date.now() };
        this.persist(entry, true);
        this.log.appendEntries([entry]);
      });
    } catch (error) { this.reloadAfterWriteFailure(); throw error; }
    const committed = this.log.getMetadata();
    for (const listener of this.metadataListeners) {
      try {
        listener(committed);
      } catch {
        // Persistence already committed. A UI observer must never turn a
        // successful metadata write into an application-level failure.
      }
    }
  }

  updateMetadata(patch: Partial<SessionMetadata>) {
    this.mutateMetadata((current) => ({ ...current, ...dropUndefined(patch) }));
  }

  clearTitleMetadata() {
    this.mutateMetadata(({
      title: _title,
      titleSource: _titleSource,
      titleUpdatedAt: _titleUpdatedAt,
      titleUserMessageId: _titleUserMessageId,
      ...metadata
    }) => metadata);
  }

  clearExternalRuntimeMetadata() {
    this.mutateMetadata(({ externalRuntime: _externalRuntime, ...metadata }) => metadata);
  }

  appendMessage(message: Message, expectedRevision?: string) {
    this.refresh();
    const revision = expectedRevision ?? this.getRevision();
    try {
      this.withWriteLock(() => {
        const entries = this.log.appendMessage(message);
        this.persist(entries, true);
      }, revision);
    } catch (error) { this.reloadAfterWriteFailure(); throw error; }
    this.publishContextCommit(revision);
    // Persistence never decides model context policy by record count.
  }

  private reloadAfterWriteFailure(): void {
    if (existsSync(this.sessionFile)) this.load();
    else { this.log = new SessionLog(); this.diskRevision = "missing"; }
  }

  appendCompaction(summary: string) {
    this.refresh();
    const entry = this.log.appendSummary(summary);
    try { this.persist(entry); } catch (error) { this.reloadAfterWriteFailure(); throw error; }
  }

  appendMarker(kind: SessionMarkerKind, value: string, expectedRevision?: string) {
    this.refresh();
    const revision = expectedRevision ?? this.getRevision();
    try {
      this.withWriteLock(() => {
        const entry = this.log.appendMarker(kind, value);
        this.persist(entry, true);
      }, revision);
    } catch (error) { this.reloadAfterWriteFailure(); throw error; }
    this.publishContextCommit(revision, kind === "conversation_clear");
  }

  appendProviderError(error: SanitizedProviderError, expectedRevision?: string) {
    this.refresh();
    try {
      this.withWriteLock(() => {
        const entry = this.log.appendProviderError(error);
        this.persist(entry, true);
      }, expectedRevision ?? this.getRevision());
    } catch (failure) { this.reloadAfterWriteFailure(); throw failure; }
  }

  compact(options?: CompactOptions): CompactResult {
    const messages = this.getMessages();
    let result = compactMessages(messages, options);
    if (!result.compacted) result = compactCurrentTurnToolGroups(messages);
    if (result.compacted && result.messages) {
      const revision = this.getRevision();
      this.commitContextCheckpoint(createContextCheckpoint(result.messages, "manual", result.summary, revision));
      this.publishContextCommit(revision, true);
    }
    return result;
  }

  /**
   * Inspect whether the session is large enough to compact and, if so, return
   * the older messages an external summarizer should condense. Returns null
   * when there isn't enough history past the last summary to bother — the
   * caller should then report "already compact enough" without calling a model.
   */
  getCompactionPlan(options?: CompactOptions): { oldMessages: Message[] } | null {
    const messages = this.getMessages();
    let candidate = compactMessages(messages, options);
    if (!candidate.compacted) candidate = compactCurrentTurnToolGroups(messages);
    if (!candidate.compacted) { this.pendingCompaction = undefined; return null; }
    this.pendingCompaction = { revision: this.getRevision(), candidate };
    // Only the portion the candidate's summary replaces: kept recent turns
    // survive verbatim, so feeding them to the summarizer would duplicate them
    // in the summary and risk overflowing the compaction request into the
    // heuristic fallback. Prior summary carriers are included so their facts
    // roll forward.
    return { oldMessages: candidate.evictedMessages ?? messages };
  }

  /**
   * Apply a precomputed (typically LLM-generated) summary as the compaction
   * checkpoint, appending an exact projection without deleting originals. Mirrors
   * `compact()` but skips the built-in heuristic summarizer. Returns
   * `{ compacted: false }` if the session is no longer compactable.
   */
  applyLLMCompaction(summary: string, options?: CompactOptions): CompactResult {
    const pending = this.pendingCompaction;
    this.pendingCompaction = undefined;
    const messages = this.getMessages();
    if (pending && pending.revision !== this.getRevision()) throw new Error("Stale compaction plan; session changed during summarization");
    let result = pending?.candidate ?? compactMessages(messages, options);
    if (!result.compacted) result = compactCurrentTurnToolGroups(messages);
    if (!result.compacted || !result.messages) return { compacted: false };
    // Replace only the summary that stands for the evicted input. A sub-turn
    // candidate also carries earlier multi-turn summaries in its pre-turn; the
    // summarizer never saw those, so they must survive verbatim.
    const summaryIndex = result.summaryIndex ?? result.messages.findIndex(isCompactionSummaryMessage);
    if (summaryIndex < 0) return { compacted: false };
    const next = result.messages.map((message, index) =>
      index === summaryIndex ? buildCompactionSummaryMessage(summary) : message);
    const revision = this.getRevision();
    this.commitContextCheckpoint(createContextCheckpoint(next, "manual", summary, revision));
    this.publishContextCommit(revision, true);
    return { ...result, summary, messages: next };
  }

  getMessages(): Message[] {
    this.refresh();
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
    this.refresh();
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
      // Harness-injected turns (goal kicks, task wakes) are internal blocks —
      // not rewind anchors, and their markup must never render in the picker.
      if (isInternalBlockOnlyContent(entry.message.content)) continue;
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
    // A rewind replaces history by explicit user action, so it selects from the
    // refreshed log under the lock rather than fencing on a resident revision:
    // a stale in-memory snapshot must not reject (or misplace) the rewrite.
    let revision = this.getRevision();
    let rewound: RewindResult | undefined;
    try {
      rewound = this.rewrite((entries) => {
        const index = entries.findIndex((entry) => entry.id === entryId && entry.type === "user_message");
        if (index < 0) return undefined;
        revision = this.getRevision();
        const target = entries[index];
        const removed = entries.slice(index);
        // Metadata records are full snapshots, not history deltas. Preserve the
        // latest snapshot (including absent/cleared fields) in the atomic rewrite.
        const metadata = { ...this.log.getMetadata() };
        if (metadata.titleUserMessageId && removed.some((entry) => entry.id === metadata.titleUserMessageId)) {
          delete metadata.title;
          delete metadata.titleSource;
          delete metadata.titleUpdatedAt;
          delete metadata.titleUserMessageId;
        }
        return {
          entries: [...entries.slice(0, index), {
            id: `metadata-${randomUUID()}`, type: "metadata", metadata, timestamp: Date.now(),
          }],
          result: {
            removedEntries: removed.length,
            targetText: target.type === "user_message" ? messageText(target.message) : "",
          },
        };
      });
    } catch (error) { this.reloadAfterWriteFailure(); throw error; }
    if (rewound) this.publishContextCommit(revision, true);
    return rewound;
  }

  getEntries(): SessionLogEntry[] {
    return this.log.list();
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  /** Commit the exact conversational projection, never delete its source history. */
  commitContextCheckpoint(checkpoint: ContextCheckpoint, expectedRevision?: string): void {
    const revision = expectedRevision ?? this.getRevision();
    this.withWriteLock(() => {
      const entries = this.log.list();
      // Replay tolerates a structurally invalid (hand-edited) checkpoint record;
      // it must not then make every later commit throw here.
      const existing = entries.find(entry => entry.type === "context_checkpoint"
        && entry.checkpoint?.compactionId === checkpoint.compactionId);
      if (existing) {
        if (existing.type !== "context_checkpoint" || JSON.stringify(existing.checkpoint) !== JSON.stringify(checkpoint)) {
          throw new Error("Conflicting context checkpoint id");
        }
        // An old receipt is not permission to restore context after clear/rewind
        // or after new conversation data has superseded this exact projection.
        if (entries.filter(affectsContextRevision).at(-1) !== existing) throw new Error("Stale context checkpoint receipt");
        return;
      }
      if (checkpoint.baseRevision !== undefined && checkpoint.baseRevision !== this.getRevision()) {
        throw new Error("Stale context checkpoint; session advanced during summarization");
      }
      checkpointMessages(checkpoint); // Validate before writing or publishing.
      const entry: SessionLogEntry = { id: `checkpoint-${checkpoint.compactionId}`, type: "context_checkpoint",
        checkpoint: structuredClone(checkpoint), timestamp: Date.now() };
      this.persist(entry, true);
      this.log.appendEntries([entry]);
    }, revision);
    this.publishContextCommit(revision);
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

  // One unreadable session — an unsupported record, a hand-edited message the
  // title/preview code cannot handle — must not take the whole listing down.
  try {
    return summarizeSessionLines(lines, file, cwdDir, stat.mtimeMs);
  } catch {
    return undefined;
  }
}

function summarizeSessionLines(lines: string[], file: string, cwdDir: string, mtime: number): SessionSummary {
  const log = new SessionLog();
  log.load(lines);
  const messages = log.toMessages();
  const metadata = log.getMetadata();
  const entries = log.list();

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
    mtime,
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
    // Skip harness-injected internal blocks (goal kicks, task wakes): they
    // must not become the /resume preview or the deterministic title.
    if (entry.type === "user_message" && !isInternalBlockOnlyContent(entry.message.content)) {
      return entry;
    }
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

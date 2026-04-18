/**
 * Session Manager - Append-only JSONL persistence over a structured session log.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { compactSessionEntries, type CompactOptions, type CompactResult } from "./context/compact.js";
import type { Message } from "./types.js";
import { SessionLog } from "./session-log.js";
import type { SessionLogEntry, SessionMarkerKind, SessionMetadata } from "./session-types.js";

export type { SessionLogEntry, SessionMarkerKind, SessionMetadata } from "./session-types.js";

export class SessionManager {
  private sessionFile: string;
  private log = new SessionLog();

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

  setMetadata(metadata: SessionMetadata) {
    const nextEntries = this.log.setMetadata(metadata);
    this.rewrite(nextEntries);
  }

  appendMessage(message: Message) {
    const entries = this.log.appendMessage(message);
    this.persist(entries);
  }

  appendCompaction(summary: string) {
    const entry = this.log.appendSummary(summary);
    this.persist(entry);
  }

  appendMarker(kind: SessionMarkerKind, value: string) {
    const entry = this.log.appendMarker(kind, value);
    this.persist(entry);
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

  getEntries(): SessionLogEntry[] {
    return this.log.list();
  }

  getSessionFile(): string {
    return this.sessionFile;
  }
}

export function getSessionsDir(cwd: string): string {
  const agentDir = process.env.BUBBLE_HOME || join(homedir(), ".bubble");
  const safeCwd = cwd.replace(/[/\\:]/g, "_");
  const sessionsDir = join(agentDir, "sessions", safeCwd);
  mkdirSync(sessionsDir, { recursive: true });
  return sessionsDir;
}

function resolveSessionFile(cwd: string, sessionName: string): string {
  return join(getSessionsDir(cwd), sessionName);
}

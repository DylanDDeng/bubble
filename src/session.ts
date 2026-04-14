/**
 * Session Manager - Append-only JSONL persistence.
 *
 * Inspired by pi-mono's tree-structured sessions.
 * For simplicity, this version uses a flat append-only log.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "./types.js";

export interface SessionEntry {
  id: string;
  type: "message" | "compaction";
  data?: Message;
  summary?: string;
  timestamp: number;
}

export class SessionManager {
  private sessionFile: string;
  private entries: SessionEntry[] = [];
  private flushed = false;

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
    if (existsSync(sessionFile)) {
      this.load();
    }
  }

  static create(cwd: string, sessionName?: string): SessionManager {
    const agentDir = join(homedir(), ".my-agent");
    const safeCwd = cwd.replace(/[/\\:]/g, "_");
    const sessionsDir = join(agentDir, "sessions", safeCwd);
    mkdirSync(sessionsDir, { recursive: true });

    const name = sessionName || `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    const file = join(sessionsDir, name);
    return new SessionManager(file);
  }

  static listSessions(cwd: string): string[] {
    const agentDir = join(homedir(), ".my-agent");
    const safeCwd = cwd.replace(/[/\\:]/g, "_");
    const sessionsDir = join(agentDir, "sessions", safeCwd);
    if (!existsSync(sessionsDir)) return [];
    // Simple listing, in real app sort by mtime
    return readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  }

  private load() {
    const content = readFileSync(this.sessionFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        this.entries.push(entry);
      } catch {
        // skip corrupt lines
      }
    }
  }

  appendMessage(message: Message) {
    const entry: SessionEntry = {
      id: `${this.entries.length + 1}`,
      type: "message",
      data: message,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.persist(entry);
  }

  appendCompaction(summary: string) {
    const entry: SessionEntry = {
      id: `${this.entries.length + 1}`,
      type: "compaction",
      summary,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.persist(entry);
  }

  private persist(entry: SessionEntry) {
    const dir = dirname(this.sessionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
    this.flushed = true;
  }

  getMessages(): Message[] {
    const messages: Message[] = [];
    let compactionIndex = -1;

    // Find the latest compaction
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === "compaction") {
        compactionIndex = i;
        break;
      }
    }

    if (compactionIndex >= 0) {
      messages.push({
        role: "system",
        content: `Previous conversation summary: ${this.entries[compactionIndex].summary}`,
      });
    }

    const startIndex = compactionIndex >= 0 ? compactionIndex + 1 : 0;
    for (let i = startIndex; i < this.entries.length; i++) {
      if (this.entries[i].type === "message" && this.entries[i].data) {
        messages.push(this.entries[i].data!);
      }
    }

    return messages;
  }

  getSessionFile(): string {
    return this.sessionFile;
  }
}

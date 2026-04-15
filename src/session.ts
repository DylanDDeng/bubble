/**
 * Session Manager - Append-only JSONL persistence.
 *
 * For simplicity, this version uses a flat append-only log.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "./types.js";

export interface SessionMetadata {
  model?: string;
}

export interface SessionEntry {
  id: string;
  type: "metadata" | "message" | "compaction";
  data?: Message;
  summary?: string;
  metadata?: SessionMetadata;
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
    const agentDir = join(homedir(), ".bubble");
    const safeCwd = cwd.replace(/[/\\:]/g, "_");
    const sessionsDir = join(agentDir, "sessions", safeCwd);
    mkdirSync(sessionsDir, { recursive: true });

    const name = sessionName || `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    const file = join(sessionsDir, name);
    return new SessionManager(file);
  }

  static listSessions(cwd: string): string[] {
    const agentDir = join(homedir(), ".bubble");
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

  private persist(entry: SessionEntry) {
    const dir = dirname(this.sessionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
    this.flushed = true;
  }

  private rewrite(entries: SessionEntry[]) {
    const dir = dirname(this.sessionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    this.entries = entries;
    this.flushed = true;
  }

  getMetadata(): SessionMetadata {
    const entry = this.entries.find((e) => e.type === "metadata");
    return entry?.metadata ?? {};
  }

  setMetadata(metadata: SessionMetadata) {
    const idx = this.entries.findIndex((e) => e.type === "metadata");
    const entry: SessionEntry = {
      id: "metadata",
      type: "metadata",
      metadata,
      timestamp: Date.now(),
    };
    if (idx >= 0) {
      const next = [...this.entries];
      next[idx] = entry;
      this.rewrite(next);
    } else {
      this.entries.unshift(entry);
      this.rewrite(this.entries);
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

    return pruneIncompleteTail(messages);
  }

  getSessionFile(): string {
    return this.sessionFile;
  }
}

function pruneIncompleteTail(messages: Message[]): Message[] {
  let currentTurnStart = -1;
  let hasCompletedAssistant = false;
  let sawNonUserInCurrentTurn = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "system") continue;

    if (message.role === "user") {
      currentTurnStart = i;
      hasCompletedAssistant = false;
      sawNonUserInCurrentTurn = false;
      continue;
    }

    if (currentTurnStart === -1) {
      continue;
    }

    sawNonUserInCurrentTurn = true;

    if (message.role === "assistant") {
      const hasPendingTools = !!message.toolCalls && message.toolCalls.length > 0;
      if (!hasPendingTools) {
        hasCompletedAssistant = true;
      }
    }
  }

  if (currentTurnStart >= 0 && sawNonUserInCurrentTurn && !hasCompletedAssistant) {
    return messages.slice(0, currentTurnStart);
  }

  return messages;
}

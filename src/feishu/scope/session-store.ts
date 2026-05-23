/**
 * sessions.json reader/writer. Keyed by `<chatId>:<userId>` (scopeKey).
 *
 * Entries hold the *current* effective cwd + sessionFile + permissionMode
 * for that (chat, user) pair. This is the truth source post-first-use:
 * scopes.json provides only the bootstrap cwd for first-time sessions.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getSessionsPath } from "../paths.js";
import { validateSessionsFile } from "../schema.js";
import type { ScopeKey, SessionEntry, SessionsFile } from "../types.js";
import type { PermissionMode } from "../../types.js";

export class SessionStore {
  private file: SessionsFile;

  constructor(file: SessionsFile) {
    this.file = file;
  }

  static load(): SessionStore {
    const path = getSessionsPath();
    if (!existsSync(path)) {
      return new SessionStore({ version: 1, sessions: {} });
    }
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) {
      return new SessionStore({ version: 1, sessions: {} });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`sessions.json is not valid JSON at ${path}`);
    }
    const result = validateSessionsFile(parsed);
    if (!result.ok || !result.value) {
      throw new Error(`sessions.json invalid:\n  - ${result.errors.join("\n  - ")}`);
    }
    return new SessionStore(result.value);
  }

  save(): void {
    writeFileSync(getSessionsPath(), JSON.stringify(this.file, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  get(scopeKey: ScopeKey): SessionEntry | undefined {
    return this.file.sessions[scopeKey];
  }

  upsert(scopeKey: ScopeKey, entry: SessionEntry): void {
    this.file.sessions[scopeKey] = entry;
    this.save();
  }

  remove(scopeKey: ScopeKey): boolean {
    if (!(scopeKey in this.file.sessions)) return false;
    delete this.file.sessions[scopeKey];
    this.save();
    return true;
  }

  setPermissionMode(scopeKey: ScopeKey, mode: PermissionMode): void {
    const entry = this.file.sessions[scopeKey];
    if (!entry) return;
    entry.permissionMode = mode;
    entry.lastActiveAt = Date.now();
    this.save();
  }

  touch(scopeKey: ScopeKey, when: number = Date.now()): void {
    const entry = this.file.sessions[scopeKey];
    if (!entry) return;
    entry.lastActiveAt = when;
    this.save();
  }

  list(): Array<{ scopeKey: ScopeKey; entry: SessionEntry }> {
    return Object.entries(this.file.sessions).map(([scopeKey, entry]) => ({ scopeKey, entry }));
  }
}

/**
 * scopes.json reader/writer.
 *
 * `cwd` here is the *initial* cwd written by the wizard. The truth source
 * for "current cwd" after first use is sessions.json. See SessionStore.
 *
 * `/feishu bind` is invoked from the TUI process, but the running serve
 * is a separate spawned subprocess — so the serve's in-memory cache would
 * go stale the moment the TUI updates scopes.json. To bridge that, every
 * read path stats the file and reloads if its mtime is newer than what
 * we have cached. The cost is one stat() call per inbound message, which
 * is negligible compared to LLM latency.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { getScopesPath } from "../paths.js";
import { validateScopesFile } from "../schema.js";
import type { ScopeConfig, ScopesFile } from "../types.js";

export class ScopeRegistry {
  private file: ScopesFile;
  private lastMtimeMs: number;

  constructor(file: ScopesFile, mtimeMs: number) {
    this.file = file;
    this.lastMtimeMs = mtimeMs;
  }

  static load(): ScopeRegistry {
    return loadFromDisk();
  }

  /**
   * Reload from disk if scopes.json has been modified since our cached copy.
   * Called from every read path so cross-process writes (e.g. `/feishu bind`
   * from the TUI updating the file while the serve subprocess is running)
   * become visible without restart.
   */
  private syncFromDiskIfChanged(): void {
    const path = getScopesPath();
    if (!existsSync(path)) {
      if (Object.keys(this.file.scopes).length > 0) {
        this.file = { version: 1, scopes: {} };
        this.lastMtimeMs = 0;
      }
      return;
    }
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return;
    }
    if (mtime <= this.lastMtimeMs) return;
    try {
      const next = loadFromDisk();
      this.file = next.file;
      this.lastMtimeMs = next.lastMtimeMs;
    } catch {
      // Bad JSON or schema mid-flight (e.g. user editing scopes.json by hand).
      // Keep the previous cached copy rather than tearing down the service.
    }
  }

  save(): void {
    writeFileSync(getScopesPath(), JSON.stringify(this.file, null, 2), { encoding: "utf8", mode: 0o600 });
    // Refresh cached mtime so the next read doesn't see *our own* write as a stale-cache miss.
    try {
      this.lastMtimeMs = statSync(getScopesPath()).mtimeMs;
    } catch {
      this.lastMtimeMs = Date.now();
    }
  }

  get(chatId: string): ScopeConfig | undefined {
    this.syncFromDiskIfChanged();
    return this.file.scopes[chatId];
  }

  has(chatId: string): boolean {
    this.syncFromDiskIfChanged();
    return chatId in this.file.scopes;
  }

  list(): Array<{ chatId: string; scope: ScopeConfig }> {
    this.syncFromDiskIfChanged();
    return Object.entries(this.file.scopes).map(([chatId, scope]) => ({ chatId, scope }));
  }

  upsert(chatId: string, scope: ScopeConfig): void {
    this.syncFromDiskIfChanged();
    this.file.scopes[chatId] = scope;
    this.save();
  }

  remove(chatId: string): boolean {
    this.syncFromDiskIfChanged();
    if (!(chatId in this.file.scopes)) return false;
    delete this.file.scopes[chatId];
    this.save();
    return true;
  }

  touch(chatId: string, when: number = Date.now()): void {
    this.syncFromDiskIfChanged();
    const scope = this.file.scopes[chatId];
    if (!scope) return;
    scope.lastActiveAt = when;
    this.save();
  }

  isUserAllowed(chatId: string, userId: string): boolean {
    this.syncFromDiskIfChanged();
    const scope = this.file.scopes[chatId];
    if (!scope) return false;
    return scope.allowedUsers.includes(userId);
  }

  isUserAdmin(chatId: string, userId: string): boolean {
    this.syncFromDiskIfChanged();
    const scope = this.file.scopes[chatId];
    if (!scope) return false;
    return scope.admins.includes(userId);
  }
}

function loadFromDisk(): ScopeRegistry {
  const path = getScopesPath();
  if (!existsSync(path)) {
    return new ScopeRegistry({ version: 1, scopes: {} }, 0);
  }
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) {
    return new ScopeRegistry({ version: 1, scopes: {} }, getMtime(path));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`scopes.json is not valid JSON at ${path}`);
  }
  const result = validateScopesFile(parsed);
  if (!result.ok || !result.value) {
    throw new Error(`scopes.json invalid:\n  - ${result.errors.join("\n  - ")}`);
  }
  return new ScopeRegistry(result.value, getMtime(path));
}

function getMtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

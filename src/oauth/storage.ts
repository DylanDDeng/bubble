/**
 * OAuth credential storage in <bubble home>/auth.json.
 *
 * The path is resolved at CONSTRUCTION time through getBubbleHome(), never at
 * module load: a module-level constant froze the real ~/.bubble at import,
 * which no test could isolate (known-defects #7) and which ignored
 * BUBBLE_HOME / dev mode while every other config file honored them
 * (config.json, sessions, memory all derive from getBubbleHome).
 *
 * The file is shared by every Bubble process on the machine (several TUIs, the
 * desktop app, the Feishu host), and OAuth refresh tokens are single-use, so a
 * stale copy is not harmless — presenting an already-rotated refresh token is
 * rejected (`refresh_token_reused`) and forces a new login. Hence:
 *   - writes are read-merge-write of ONE key plus an atomic rename, never a
 *     dump of this process's whole in-memory map over the file;
 *   - reads follow the file (mtime/size check) so a token rotated by another
 *     process is picked up instead of the stale in-memory one;
 *   - withRefreshLock() serializes refreshes across processes.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import type { OAuthCredentials } from "./types.js";

/** A refresh is one HTTPS round-trip; a lock older than this is a crashed holder. */
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_WAIT_MS = 20_000;
const REFRESH_LOCK_POLL_MS = 50;

export class AuthStorage {
  private data: Record<string, OAuthCredentials> = {};
  /** mtime+size of the file as last read/written, to detect foreign writes. */
  private diskStamp: string | undefined;
  private mutationListeners: Array<(providerId: string) => void> = [];
  private readonly authPath: string;

  constructor(authPath = join(getBubbleHome(), "auth.json")) {
    this.authPath = authPath;
    this.load();
  }

  /**
   * Observe credential writes/removals. Callers across the codebase mutate
   * this storage directly (login/logout flows), so consumers that must react
   * to credential-identity changes (ProviderRegistry's routing revision)
   * subscribe here instead of wrapping every call site.
   */
  onMutation(listener: (providerId: string) => void): () => void {
    this.mutationListeners.push(listener);
    return () => {
      this.mutationListeners = this.mutationListeners.filter((item) => item !== listener);
    };
  }

  private notifyMutation(providerId: string) {
    for (const listener of this.mutationListeners) {
      try {
        listener(providerId);
      } catch {
        // Listeners must never break credential writes.
      }
    }
  }

  private stampOf(): string | undefined {
    try {
      const stat = statSync(this.authPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  }

  private readDisk(): Record<string, OAuthCredentials> {
    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf-8")) as Record<string, OAuthCredentials>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private load() {
    this.diskStamp = this.stampOf();
    this.data = this.diskStamp === undefined ? {} : this.readDisk();
  }

  /**
   * Adopt writes made by other processes; notifies for the keys that changed.
   * `force` skips the stamp shortcut: a token rotation keeps the file size, so
   * on a coarse-mtime filesystem the stamp alone can miss it. The refresh and
   * write paths cannot afford that.
   */
  private sync(force = false) {
    const stamp = this.stampOf();
    if (!force && stamp === this.diskStamp) return;
    const previous = this.data;
    this.diskStamp = stamp;
    this.data = stamp === undefined ? {} : this.readDisk();
    for (const key of new Set([...Object.keys(previous), ...Object.keys(this.data)])) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(this.data[key])) this.notifyMutation(key);
    }
  }

  /** Read-merge-write of a single key: entries owned by other processes survive. */
  private commit(providerId: string, creds: OAuthCredentials | undefined) {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.sync(true);
    const next = { ...this.data };
    if (creds) next[providerId] = creds;
    else delete next[providerId];
    const tmpPath = `${this.authPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmpPath, this.authPath);
    this.data = next;
    this.diskStamp = this.stampOf();
  }

  /** Force a re-read of the file (see sync). */
  reload(): void {
    this.sync(true);
  }

  /**
   * Serialize token refreshes across processes. Callers must re-read the
   * credentials inside `fn`: whoever held the lock before may already have
   * rotated them. Best effort by design — a stale lock is broken and a long
   * wait falls through, because a missed lock costs at most one re-login while
   * a stuck one would hang every request.
   */
  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.authPath}.lock`;
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
    let held = false;
    while (!held) {
      try {
        const dir = dirname(lockPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        closeSync(openSync(lockPath, "wx", 0o600));
        held = true;
      } catch {
        let ageMs: number | undefined;
        try {
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          continue; // released between our open and stat: retry at once
        }
        if (ageMs > REFRESH_LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another waiter broke it first.
          }
          continue;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
      }
    }
    try {
      return await fn();
    } finally {
      if (held) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already broken as stale by another process.
        }
      }
    }
  }

  getPath(): string {
    return this.authPath;
  }

  get(providerId: string): OAuthCredentials | undefined {
    this.sync();
    return this.data[providerId];
  }

  set(providerId: string, creds: OAuthCredentials) {
    this.commit(providerId, creds);
    this.notifyMutation(providerId);
  }

  remove(providerId: string) {
    this.commit(providerId, undefined);
    this.notifyMutation(providerId);
  }

  has(providerId: string): boolean {
    this.sync();
    return !!this.data[providerId];
  }

  isExpired(providerId: string, graceMs = 5 * 60 * 1000): boolean {
    this.sync();
    const creds = this.data[providerId];
    if (!creds) return true;
    return Date.now() >= creds.expiresAt - graceMs;
  }

  getAccessToken(providerId: string): string | undefined {
    this.sync();
    return this.data[providerId]?.accessToken;
  }

  list(): string[] {
    this.sync();
    return Object.keys(this.data);
  }
}

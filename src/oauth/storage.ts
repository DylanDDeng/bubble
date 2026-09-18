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
 *
 * Node has no flock, so both locks are O_EXCL lock files carrying an owner
 * token: a holder only ever deletes a lock whose content is its own token,
 * and a stale lock is only broken after re-verifying it is still the one that
 * was observed. That last check-then-unlink is not atomic (nothing portable
 * is); the residual window is a few microseconds and needs a crashed holder
 * plus two simultaneous breakers. The refresh path tolerates even that: a
 * rejected token triggers a second look at the file (ProviderRegistry).
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import type { OAuthCredentials } from "./types.js";

/**
 * The refresh holder heartbeats its lock, so "stale" means the holder is gone,
 * not merely slow. Waiters outlast the stale threshold: a crashed holder is
 * always recovered from, and only a live, stuck one makes a waiter give up.
 */
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_HEARTBEAT_MS = 5_000;
const REFRESH_LOCK_WAIT_MS = 90_000;
const REFRESH_LOCK_POLL_MS = 50;
/** The write lock spans a few ms of synchronous file I/O. */
const WRITE_LOCK_STALE_MS = 5_000;
const WRITE_LOCK_WAIT_MS = 15_000;
const WRITE_LOCK_POLL_MS = 5;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * One acquisition attempt. Returns the owner token, or undefined on contention
 * (after breaking the lock if it was stale, so the caller's retry can win).
 * Anything but EEXIST is a real error — an unwritable home must surface, not
 * be mistaken for contention and retried forever.
 */
function tryAcquireLock(lockPath: string, staleMs: number): string | undefined {
  const token = `${process.pid}:${randomUUID()}`;
  let fd: number;
  try {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    breakLockIfStale(lockPath, staleMs);
    return undefined;
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return token;
}

function observeLock(lockPath: string): { token: string; mtimeMs: number } | undefined {
  try {
    return { mtimeMs: statSync(lockPath).mtimeMs, token: readFileSync(lockPath, "utf-8") };
  } catch {
    return undefined; // released meanwhile
  }
}

function breakLockIfStale(lockPath: string, staleMs: number): void {
  const observed = observeLock(lockPath);
  if (!observed || Date.now() - observed.mtimeMs <= staleMs) return;
  // Another waiter may have broken it and a successor acquired the path since:
  // only remove the exact lock that was judged stale.
  const current = observeLock(lockPath);
  if (!current || current.token !== observed.token || current.mtimeMs !== observed.mtimeMs) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/** Never delete a lock that is not ours (ours may have been broken as stale). */
function releaseLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

export class AuthStorage {
  private data: Record<string, OAuthCredentials> = {};
  /** Identity of the file as last read/written, to detect foreign writes. */
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
      // ino + ctime: every write replaces the file by rename, so they change
      // even when a same-size rotation lands within one coarse mtime tick.
      return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
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
  sync(force = false): void {
    const stamp = this.stampOf();
    if (!force && stamp === this.diskStamp) return;
    const previous = this.data;
    this.diskStamp = stamp;
    this.data = stamp === undefined ? {} : this.readDisk();
    for (const key of new Set([...Object.keys(previous), ...Object.keys(this.data)])) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(this.data[key])) this.notifyMutation(key);
    }
  }

  /**
   * Read-merge-write of a single key: entries owned by other processes survive.
   * The whole sequence runs under the cross-process write lock — without it a
   * process could read, lose the CPU while another persists a rotated token,
   * then rename its older snapshot over it.
   */
  private commit(
    providerId: string,
    creds: OAuthCredentials | undefined,
    /** Compare-and-set guard, checked under the lock against the re-read file. */
    guard?: (onDisk: OAuthCredentials | undefined) => boolean,
  ): boolean {
    const lockPath = `${this.authPath}.wlock`;
    const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
    let token = tryAcquireLock(lockPath, WRITE_LOCK_STALE_MS);
    while (token === undefined) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the credential write lock (${lockPath}).`);
      }
      sleepSync(WRITE_LOCK_POLL_MS);
      token = tryAcquireLock(lockPath, WRITE_LOCK_STALE_MS);
    }
    try {
      this.sync(true);
      if (guard && !guard(this.data[providerId])) return false;
      const next = { ...this.data };
      if (creds) next[providerId] = creds;
      else delete next[providerId];
      const tmpPath = `${this.authPath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmpPath, this.authPath);
      this.data = next;
      this.diskStamp = this.stampOf();
      return true;
    } finally {
      releaseLock(lockPath, token);
    }
  }

  /** Force a re-read of the file (see sync). */
  reload(): void {
    this.sync(true);
  }

  /**
   * Serialize token refreshes across processes. Callers must re-read the
   * credentials inside `fn`: whoever held the lock before may already have
   * rotated them. `fn` never runs without the lock — presenting a single-use
   * refresh token concurrently can void the login, while a timeout only costs
   * one retryable request.
   */
  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.authPath}.lock`;
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
    let token = tryAcquireLock(lockPath, REFRESH_LOCK_STALE_MS);
    while (token === undefined) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for another Bubble process to finish refreshing credentials. Try again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
      token = tryAcquireLock(lockPath, REFRESH_LOCK_STALE_MS);
    }
    const owned = token;
    const heartbeat = setInterval(() => {
      try {
        if (readFileSync(lockPath, "utf-8") === owned) utimesSync(lockPath, new Date(), new Date());
      } catch {
        // Lock gone: nothing to keep alive.
      }
    }, REFRESH_LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      releaseLock(lockPath, owned);
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

  /**
   * Store the result of a refresh only if the entry is still the one that was
   * refreshed (`fromRefreshToken`; null = the key must still be absent). A
   * /login or /logout in another process only takes the write lock, so it can
   * land while a refresh request is in flight; its outcome must win over a
   * result derived from the credentials it replaced.
   */
  replaceIfUnchanged(providerId: string, creds: OAuthCredentials, fromRefreshToken: string | null): boolean {
    const written = this.commit(providerId, creds, (onDisk) =>
      fromRefreshToken === null ? onDisk === undefined : onDisk?.refreshToken === fromRefreshToken);
    if (written) this.notifyMutation(providerId);
    return written;
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

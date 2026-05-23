/**
 * Bridges scopeKey ↔ on-disk SessionManager (reuses ~/.bubble/sessions/<safe_cwd>/<name>.jsonl).
 *
 * SessionStore (sessions.json) is the index: scopeKey → { sessionFile, cwd, mode }.
 * On first traffic for a scope we bootstrap from ScopeConfig.cwd.
 * /cd and /new both archive (keep file on disk, just stop pointing at it) and start fresh.
 */

import { existsSync } from "node:fs";
import { SessionManager, type SessionSummary } from "../../session.js";
import type { PermissionMode } from "../../types.js";
import type { SessionStore } from "./session-store.js";
import type { ScopeKey, SessionEntry } from "../types.js";

export interface OpenedSession {
  manager: SessionManager;
  cwd: string;
  permissionMode: PermissionMode;
  /** True iff this call created a brand-new session file (no prior history). */
  fresh: boolean;
}

export class SessionBinder {
  constructor(private readonly store: SessionStore) {}

  /**
   * Get the current session for (scopeKey). If sessions.json has a valid
   * pointer, reuse it. Otherwise, bootstrap a new session with `bootstrapCwd`
   * and `bootstrapMode`.
   */
  openOrBootstrap(scopeKey: ScopeKey, bootstrapCwd: string, bootstrapMode: PermissionMode): OpenedSession {
    const entry = this.store.get(scopeKey);
    if (entry && existsSync(entry.sessionFile)) {
      return {
        manager: new SessionManager(entry.sessionFile),
        cwd: entry.cwd,
        permissionMode: entry.permissionMode,
        fresh: false,
      };
    }
    // Bootstrap: pointer is missing or file got removed externally.
    return this.createFresh(scopeKey, bootstrapCwd, bootstrapMode);
  }

  /** Start a brand-new session at `cwd` with `mode`, replacing the pointer. */
  createFresh(scopeKey: ScopeKey, cwd: string, mode: PermissionMode): OpenedSession {
    const name = makeSessionName(scopeKey);
    const manager = SessionManager.create(cwd, name);
    // Persist metadata immediately so the on-disk file exists from this point
    // on — otherwise openOrBootstrap() on the next call would see the pointer
    // but no file and re-bootstrap, losing the pointer.
    manager.setMetadata({ cwd });
    const entry: SessionEntry = {
      sessionFile: manager.getSessionFile(),
      cwd,
      permissionMode: mode,
      lastActiveAt: Date.now(),
    };
    this.store.upsert(scopeKey, entry);
    return { manager, cwd, permissionMode: mode, fresh: true };
  }

  /**
   * /cd: archive (pointer-rotate) and create a new session at newCwd.
   * Permission mode carries over.
   */
  changeCwd(scopeKey: ScopeKey, newCwd: string): OpenedSession {
    const prev = this.store.get(scopeKey);
    const mode = prev?.permissionMode ?? "default";
    return this.createFresh(scopeKey, newCwd, mode);
  }

  /** /resume <name>: re-point sessions.json to an existing file. */
  resumeNamed(scopeKey: ScopeKey, sessionFile: string): OpenedSession | undefined {
    if (!existsSync(sessionFile)) return undefined;
    const prev = this.store.get(scopeKey);
    const manager = new SessionManager(sessionFile);
    const meta = manager.getMetadata();
    const cwd = meta.cwd ?? prev?.cwd;
    if (!cwd) return undefined;
    const mode = prev?.permissionMode ?? "default";
    const entry: SessionEntry = {
      sessionFile,
      cwd,
      permissionMode: mode,
      lastActiveAt: Date.now(),
    };
    this.store.upsert(scopeKey, entry);
    return { manager, cwd, permissionMode: mode, fresh: false };
  }

  /** List sessions (feishu-prefixed) under `cwd` for the /resume picker. */
  listResumable(cwd: string, limit: number = 10): SessionSummary[] {
    const all = SessionManager.summarizeSessionsForCwd(cwd);
    const feishu = all.filter((s) => s.name.startsWith("feishu-"));
    return feishu.slice(0, limit);
  }

  /**
   * Update the persisted permission mode for a scopeKey. Called by /mode and
   * by the agent's onModeUpdate hook.
   */
  setMode(scopeKey: ScopeKey, mode: PermissionMode): void {
    this.store.setPermissionMode(scopeKey, mode);
  }
}

let SESSION_NAME_COUNTER = 0;

function makeSessionName(scopeKey: ScopeKey): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = scopeKey.replace(/[^A-Za-z0-9_-]/g, "_");
  // Counter disambiguates back-to-back creates within the same millisecond.
  const seq = (SESSION_NAME_COUNTER++).toString(36);
  return `feishu-${safe}-${ts}-${seq}.jsonl`;
}

/**
 * OAuth credential storage in <bubble home>/auth.json.
 *
 * The path is resolved at CONSTRUCTION time through getBubbleHome(), never at
 * module load: a module-level constant froze the real ~/.bubble at import,
 * which no test could isolate (known-defects #7) and which ignored
 * BUBBLE_HOME / dev mode while every other config file honored them
 * (config.json, sessions, memory all derive from getBubbleHome).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import type { OAuthCredentials } from "./types.js";

export class AuthStorage {
  private data: Record<string, OAuthCredentials> = {};
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

  private load() {
    if (!existsSync(this.authPath)) return;
    try {
      const raw = readFileSync(this.authPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, OAuthCredentials>;
      this.data = parsed;
    } catch {
      this.data = {};
    }
  }

  private save() {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.authPath, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
  }

  getPath(): string {
    return this.authPath;
  }

  get(providerId: string): OAuthCredentials | undefined {
    return this.data[providerId];
  }

  set(providerId: string, creds: OAuthCredentials) {
    this.data[providerId] = creds;
    this.save();
    this.notifyMutation(providerId);
  }

  remove(providerId: string) {
    delete this.data[providerId];
    this.save();
    this.notifyMutation(providerId);
  }

  has(providerId: string): boolean {
    return !!this.data[providerId];
  }

  isExpired(providerId: string, graceMs = 5 * 60 * 1000): boolean {
    const creds = this.data[providerId];
    if (!creds) return true;
    return Date.now() >= creds.expiresAt - graceMs;
  }

  getAccessToken(providerId: string): string | undefined {
    return this.data[providerId]?.accessToken;
  }

  list(): string[] {
    return Object.keys(this.data);
  }
}

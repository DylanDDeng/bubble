/**
 * OAuth credential storage in ~/.bubble/auth.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { OAuthCredentials } from "./types.js";

const AUTH_PATH = join(homedir(), ".bubble", "auth.json");

export class AuthStorage {
  private data: Record<string, OAuthCredentials> = {};
  private mutationListeners: Array<(providerId: string) => void> = [];

  constructor() {
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
    if (!existsSync(AUTH_PATH)) return;
    try {
      const raw = readFileSync(AUTH_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, OAuthCredentials>;
      this.data = parsed;
    } catch {
      this.data = {};
    }
  }

  private save() {
    const dir = dirname(AUTH_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(AUTH_PATH, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
  }

  getPath(): string {
    return AUTH_PATH;
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

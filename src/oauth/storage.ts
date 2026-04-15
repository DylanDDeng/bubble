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

  constructor() {
    this.load();
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
  }

  remove(providerId: string) {
    delete this.data[providerId];
    this.save();
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

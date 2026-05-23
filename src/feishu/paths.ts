/**
 * Path helpers for the Feishu host. All state lives under
 * `~/.bubble/feishu/` (or the dev/test variants, via getBubbleHome()).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

export function getFeishuHome(): string {
  const dir = join(getBubbleHome(), "feishu");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getConfigPath(): string {
  return join(getFeishuHome(), "config.json");
}

export function getSecretsPath(): string {
  return join(getFeishuHome(), "secrets.enc");
}

export function getScopesPath(): string {
  return join(getFeishuHome(), "scopes.json");
}

export function getSessionsPath(): string {
  return join(getFeishuHome(), "sessions.json");
}

export function getProcessRegistryPath(): string {
  return join(getFeishuHome(), "processes.json");
}

export function getLogsDir(): string {
  const dir = join(getFeishuHome(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMediaDir(chatId: string): string {
  const safe = chatId.replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = join(getFeishuHome(), "media", safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

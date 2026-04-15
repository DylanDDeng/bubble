/**
 * User-level configuration manager.
 *
 * Uses a single JSON file in ~/.bubble/config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ProviderProfile } from "./provider-registry.js";

const CONFIG_PATH = join(homedir(), ".bubble", "config.json");

export interface UserConfigData {
  defaultModel?: string;
  recentModels?: string[];
  apiKey?: string;
  providers?: ProviderProfile[];
  defaultProvider?: string;
}

export class UserConfig {
  private data: UserConfigData = {};

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(CONFIG_PATH)) return;
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      this.data = JSON.parse(raw) as UserConfigData;
    } catch {
      this.data = {};
    }
  }

  private save() {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(this.data, null, 2) + "\n");
  }

  getDefaultModel(): string | undefined {
    return this.data.defaultModel;
  }

  setDefaultModel(model: string) {
    this.data.defaultModel = model;
    this.save();
  }

  getRecentModels(): string[] {
    return this.data.recentModels?.slice() ?? [];
  }

  pushRecentModel(model: string) {
    const recent = this.data.recentModels ?? [];
    const uniq = [model, ...recent.filter((m) => m !== model)];
    this.data.recentModels = uniq.slice(0, 10);
    this.save();
  }

  getApiKey(): string | undefined {
    return this.data.apiKey;
  }

  setApiKey(key: string) {
    this.data.apiKey = key;
    this.save();
  }

  getProviders(): ProviderProfile[] {
    return this.data.providers?.slice() ?? [];
  }

  setProviders(providers: ProviderProfile[]) {
    this.data.providers = providers;
    this.save();
  }

  getDefaultProvider(): string | undefined {
    return this.data.defaultProvider;
  }

  setDefaultProvider(id: string) {
    this.data.defaultProvider = id;
    this.save();
  }
}

/** Mask an API key for safe display. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

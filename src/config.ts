/**
 * User-level configuration manager.
 *
 * Uses a single JSON file in ~/.bubble/config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ProviderProfile } from "./provider-registry.js";
import type { ThinkingLevel } from "./types.js";

const HIDDEN_PROVIDER_IDS = new Set(["openrouter", "openai-codex"]);

function getConfigPath(): string {
  const root = process.env.BUBBLE_HOME || join(homedir(), ".bubble");
  return join(root, "config.json");
}

function isHiddenProviderId(providerId?: string): boolean {
  return !!providerId && HIDDEN_PROVIDER_IDS.has(providerId);
}

function modelProviderId(model: string): string | undefined {
  if (!model.includes(":")) return undefined;
  return model.split(":", 1)[0];
}

function sanitizeRecentModels(models?: string[]): string[] | undefined {
  if (!models) return undefined;
  return models.filter((model) => !isHiddenProviderId(modelProviderId(model)));
}

function sanitizeProviders(providers?: ProviderProfile[]): ProviderProfile[] | undefined {
  if (!providers) return undefined;
  return providers.filter((provider) => !isHiddenProviderId(provider.id));
}

function sanitizeDefaultModel(model?: string): string | undefined {
  if (!model) return undefined;
  return isHiddenProviderId(modelProviderId(model)) ? undefined : model;
}

function sanitizeDefaultProvider(providerId?: string): string | undefined {
  return isHiddenProviderId(providerId) ? undefined : providerId;
}

export interface UserConfigData {
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  skillPaths?: string[];
  theme?: Record<string, string>;
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
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return;
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as UserConfigData;
      this.data = {
        ...parsed,
        defaultModel: sanitizeDefaultModel(parsed.defaultModel),
        recentModels: sanitizeRecentModels(parsed.recentModels),
        providers: sanitizeProviders(parsed.providers),
        defaultProvider: sanitizeDefaultProvider(parsed.defaultProvider),
      };
    } catch {
      this.data = {};
    }
  }

  private save() {
    const configPath = getConfigPath();
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify(this.data, null, 2) + "\n");
  }

  getDefaultModel(): string | undefined {
    return sanitizeDefaultModel(this.data.defaultModel)
      ?? sanitizeRecentModels(this.data.recentModels)?.[0];
  }

  setDefaultModel(model: string) {
    this.data.defaultModel = sanitizeDefaultModel(model);
    this.save();
  }

  getDefaultThinkingLevel(): ThinkingLevel | undefined {
    return this.data.defaultThinkingLevel;
  }

  setDefaultThinkingLevel(level: ThinkingLevel) {
    this.data.defaultThinkingLevel = level;
    this.save();
  }

  getRecentModels(): string[] {
    return sanitizeRecentModels(this.data.recentModels)?.slice() ?? [];
  }

  pushRecentModel(model: string) {
    if (isHiddenProviderId(modelProviderId(model))) {
      return;
    }
    const recent = this.data.recentModels ?? [];
    const uniq = [model, ...recent.filter((m) => m !== model)];
    const sanitized = sanitizeRecentModels(uniq.slice(0, 10));
    this.data.recentModels = sanitized;
    this.data.defaultModel = sanitized?.[0];
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
    return sanitizeProviders(this.data.providers)?.slice() ?? [];
  }

  setProviders(providers: ProviderProfile[]) {
    this.data.providers = sanitizeProviders(providers);
    this.save();
  }

  getDefaultProvider(): string | undefined {
    return sanitizeDefaultProvider(this.data.defaultProvider);
  }

  setDefaultProvider(id: string) {
    this.data.defaultProvider = sanitizeDefaultProvider(id);
    this.save();
  }

  getSkillPaths(): string[] {
    return Array.isArray(this.data.skillPaths) ? this.data.skillPaths.slice() : [];
  }

  setSkillPaths(paths: string[]) {
    this.data.skillPaths = paths.slice();
    this.save();
  }

  getTheme(): Record<string, string> {
    const theme = this.data.theme;
    if (!theme || typeof theme !== "object" || Array.isArray(theme)) return {};
    return Object.fromEntries(
      Object.entries(theme).filter(([, value]) => typeof value === "string"),
    );
  }

  setTheme(theme: Record<string, string>) {
    this.data.theme = { ...theme };
    this.save();
  }
}

/** Mask an API key for safe display. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

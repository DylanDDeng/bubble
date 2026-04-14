/**
 * User-level configuration manager.
 *
 * Inspired by opencode's workspace + global config layering.
 * For our lightweight agent, we use a single JSON file in ~/.my-agent/config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".my-agent", "config.json");

export interface UserConfigData {
  defaultModel?: string;
  recentModels?: string[];
  apiKey?: string;
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
}

/** Mask an API key for safe display. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

/** Normalize a model string by stripping accidental openrouter/ prefix. */
export function normalizeModel(model: string): string {
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

/** Strip provider prefix for display if it's openrouter. */
export function displayModel(model: string): string {
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

/** Built-in curated list of popular OpenRouter models (native IDs). */
export const POPULAR_MODELS: string[] = [
  "z-ai/glm-5.1",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
  "anthropic/claude-3.7-sonnet",
  "anthropic/claude-3.5-sonnet",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-pro-preview-03-25",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.3-70b-instruct",
  "nousresearch/hermes-3-llama-3.1-405b",
  "qwen/qwen-2.5-72b-instruct",
];

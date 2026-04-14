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
}

/** Normalize a model string to "provider/model" format. */
export function normalizeModel(model: string): string {
  if (model.includes("/")) return model;
  return `openrouter/${model}`;
}

/** Strip provider prefix for display if it's openrouter. */
export function displayModel(model: string): string {
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

/** Built-in curated list of popular OpenRouter models. */
export const POPULAR_MODELS: string[] = [
  "openrouter/z-ai/glm-5.1",
  "openrouter/deepseek/deepseek-chat",
  "openrouter/deepseek/deepseek-r1",
  "openrouter/anthropic/claude-3.7-sonnet",
  "openrouter/anthropic/claude-3.5-sonnet",
  "openrouter/openai/gpt-4o",
  "openrouter/openai/gpt-4o-mini",
  "openrouter/google/gemini-2.5-pro-preview-03-25",
  "openrouter/google/gemini-2.0-flash-001",
  "openrouter/meta-llama/llama-3.3-70b-instruct",
  "openrouter/nousresearch/hermes-3-llama-3.1-405b",
  "openrouter/qwen/qwen-2.5-72b-instruct",
];

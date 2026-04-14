/**
 * models.json loader - inspired by pi-mono's model configuration.
 *
 * Users can define providers, API keys, base URLs, and custom models
 * in ~/.my-agent/models.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelInfo } from "./provider-registry.js";

const MODELS_PATH = join(homedir(), ".my-agent", "models.json");

export interface ProviderModelConfig {
  baseURL?: string;
  apiKey?: string;
  models?: Array<{ id: string; name?: string }>;
}

export interface ModelsConfig {
  providers: Record<string, ProviderModelConfig>;
}

export class ModelConfig {
  private data?: ModelsConfig;
  private loadError?: string;

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(MODELS_PATH)) return;
    try {
      const raw = readFileSync(MODELS_PATH, "utf-8");
      this.data = JSON.parse(raw) as ModelsConfig;
    } catch (err: any) {
      this.loadError = err.message;
    }
  }

  getLoadError(): string | undefined {
    return this.loadError;
  }

  getPath(): string {
    return MODELS_PATH;
  }

  getProviderConfig(providerId: string): ProviderModelConfig | undefined {
    return this.data?.providers?.[providerId];
  }

  getAllProviders(): Record<string, ProviderModelConfig> {
    return this.data?.providers ?? {};
  }

  hasProvider(providerId: string): boolean {
    return !!this.data?.providers?.[providerId];
  }

  getCustomModels(providerId: string): ModelInfo[] {
    const cfg = this.data?.providers?.[providerId];
    if (!cfg?.models) return [];
    return cfg.models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      providerId,
    }));
  }

  getApiKey(providerId: string): string | undefined {
    return this.data?.providers?.[providerId]?.apiKey;
  }

  getBaseURL(providerId: string): string | undefined {
    return this.data?.providers?.[providerId]?.baseURL;
  }
}

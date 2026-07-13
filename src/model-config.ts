/**
 * models.json loader.
 *
 * Users can define providers, API keys, base URLs, and custom models
 * in ~/.bubble/models.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelTier, ProviderProtocol } from "./model-catalog.js";
import type { ModelInfo } from "./provider-registry.js";

const MODELS_PATH = join(homedir(), ".bubble", "models.json");

export interface ProviderModelConfig {
  baseURL?: string;
  apiKey?: string;
  protocol?: ProviderProtocol;
  models?: Array<{ id: string; name?: string; tier?: ModelTier; routingPriority?: number }>;
}

const MODEL_TIERS: ModelTier[] = ["fast", "balanced", "strong"];

function sanitizeTier(value: unknown): ModelTier | undefined {
  return typeof value === "string" && MODEL_TIERS.includes(value as ModelTier)
    ? (value as ModelTier)
    : undefined;
}

function sanitizeRoutingPriority(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
      tier: sanitizeTier(m.tier),
      routingPriority: sanitizeRoutingPriority(m.routingPriority),
    }));
  }

  getApiKey(providerId: string): string | undefined {
    return this.data?.providers?.[providerId]?.apiKey;
  }

  getBaseURL(providerId: string): string | undefined {
    return this.data?.providers?.[providerId]?.baseURL;
  }

  getProtocol(providerId: string): ProviderProtocol | undefined {
    return this.data?.providers?.[providerId]?.protocol;
  }
}

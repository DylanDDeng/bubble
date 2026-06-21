import type { Provider, ThinkingLevel } from "../types.js";
import type { ProviderProfile } from "../provider-registry.js";
import { decodeModel, displayModel } from "../provider-registry.js";
import { buildSystemPrompt, type SystemPromptOptions } from "../system-prompt.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "../provider-transform.js";

export interface ModelSwitchAgent {
  model: string;
  providerId: string;
  thinking: ThinkingLevel;
  setProvider(provider: Provider): void;
  setSystemPrompt(prompt: string): void;
}

export interface ModelSwitchRegistry {
  prepareProvider(providerId: string): Promise<void>;
  getConfigured(): ProviderProfile[];
  getDefault(): ProviderProfile | undefined;
}

export interface ModelSwitchSession {
  updateMetadata(metadata: { model: string; thinkingLevel: ThinkingLevel; reasoningEffort: ThinkingLevel }): void;
  appendMarker(kind: "model_switch", value: string): void;
}

export interface SwitchAgentModelOptions {
  model: string;
  agent: ModelSwitchAgent;
  registry: ModelSwitchRegistry;
  createProvider: ((providerId: string, apiKey: string, baseURL: string) => Provider) | undefined;
  workingDir: string;
  systemPromptOptions: Omit<SystemPromptOptions, "agentName" | "configuredProvider" | "configuredModel" | "configuredModelId" | "thinkingLevel" | "workingDir">;
  rememberModel(model: string): void;
  setThinkingLevel(level: ThinkingLevel): void;
  sessionManager?: ModelSwitchSession;
}

export function modelSwitchTarget(
  model: string,
  fallbackProviderId: string | undefined,
): { providerId: string; modelId: string } {
  const decoded = decodeModel(model);
  return {
    providerId: decoded.providerId || fallbackProviderId || "openai",
    modelId: decoded.modelId,
  };
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("refresh_token_reused")
    || message.includes("invalid_grant")
    || message.includes("Your refresh token has already been used")
  ) {
    return "OpenAI login expired. Run /login openai again to refresh your ChatGPT credentials.";
  }
  return message;
}

export function formatModelSwitchError(model: string, error: unknown): string {
  return `Failed to switch model to ${displayModel(model)}: ${errorMessage(error)}`;
}

export async function switchAgentModel(options: SwitchAgentModelOptions): Promise<ThinkingLevel> {
  const { providerId, modelId } = modelSwitchTarget(
    options.model,
    options.agent.providerId || options.registry.getDefault()?.id,
  );

  await options.registry.prepareProvider(providerId);
  const provider = options.registry.getConfigured().find((item) => item.id === providerId);
  if (!provider?.apiKey || !options.createProvider) {
    throw new Error(`Provider ${providerId} is not configured or has no active credentials.`);
  }

  const nextThinkingLevel = normalizeThinkingLevel(
    options.agent.thinking || getDefaultThinkingLevel(providerId, modelId),
    getAvailableThinkingLevels(providerId, modelId),
  );
  const nextProvider = options.createProvider(providerId, provider.apiKey, provider.baseURL);
  const nextSystemPrompt = buildSystemPrompt({
    agentName: "Bubble",
    configuredProvider: providerId,
    configuredModel: displayModel(options.model),
    configuredModelId: options.model,
    thinkingLevel: nextThinkingLevel,
    workingDir: options.workingDir,
    ...options.systemPromptOptions,
  });

  options.agent.model = options.model;
  options.agent.thinking = nextThinkingLevel;
  options.agent.setProvider(nextProvider);
  options.agent.providerId = providerId;
  options.agent.setSystemPrompt(nextSystemPrompt);
  options.rememberModel(options.model);
  options.setThinkingLevel(nextThinkingLevel);
  options.sessionManager?.updateMetadata({
    model: options.model,
    thinkingLevel: nextThinkingLevel,
    reasoningEffort: nextThinkingLevel,
  });
  options.sessionManager?.appendMarker("model_switch", options.model);

  return nextThinkingLevel;
}

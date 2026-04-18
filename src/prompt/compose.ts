import type { AgentMode, ThinkingLevel } from "../types.js";
import { buildAnthropicProviderPrompt } from "./provider-prompts/anthropic.js";
import { buildCodexProviderPrompt } from "./provider-prompts/codex.js";
import { buildDefaultProviderPrompt } from "./provider-prompts/default.js";
import { buildGeminiProviderPrompt } from "./provider-prompts/gemini.js";
import { buildGptProviderPrompt } from "./provider-prompts/gpt.js";
import { buildEnvironmentPrompt, defaultToolNames, type EnvironmentPromptOptions } from "./environment.js";
import { buildRuntimePrompt } from "./runtime.js";
import { buildSkillsPrompt } from "./skills.js";
import type { SkillSummary } from "../skills/types.js";

export interface ComposeSystemPromptOptions extends EnvironmentPromptOptions {
  agentName?: string;
  guidelines?: string[];
  thinkingLevel?: ThinkingLevel;
  mode?: AgentMode;
  skills?: SkillSummary[];
}

export function composeSystemPrompt(options: ComposeSystemPromptOptions = {}): string {
  const agentName = options.agentName ?? "Bubble";
  const providerPrompt = buildProviderPrompt(agentName, options.configuredProvider, options.configuredModelId, options.configuredModel);
  const environmentPrompt = buildEnvironmentPrompt({
    configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel,
    configuredModelId: options.configuredModelId,
    workingDir: options.workingDir,
    currentDate: options.currentDate,
    tools: options.tools ?? defaultToolNames,
    toolSnippets: options.toolSnippets,
  });
  const runtimePrompt = buildRuntimePrompt({
    thinkingLevel: options.thinkingLevel,
    mode: options.mode,
    guidelines: buildGuidelines(options.tools ?? defaultToolNames, options.guidelines ?? []),
  });
  const skillsPrompt = buildSkillsPrompt(options.skills ?? []);

  return [providerPrompt, environmentPrompt, runtimePrompt, skillsPrompt].filter(Boolean).join("\n\n");
}

function buildProviderPrompt(
  agentName: string,
  providerId?: string,
  modelId?: string,
  modelName?: string,
): string {
  const provider = providerId ?? "";
  const rawModel = modelId ?? modelName ?? "";
  const model = rawModel.includes(":") ? rawModel.split(":").slice(1).join(":") : rawModel;

  if (provider === "anthropic" || model.startsWith("claude")) {
    return buildAnthropicProviderPrompt(agentName);
  }
  if (provider === "google" || model.startsWith("gemini")) {
    return buildGeminiProviderPrompt(agentName);
  }
  if (provider === "openai-codex" || model.includes("codex") || model.startsWith("gpt-5")) {
    return buildCodexProviderPrompt(agentName);
  }
  if (provider === "openai" || provider === "openrouter" || model.startsWith("gpt") || model.startsWith("o1")) {
    return buildGptProviderPrompt(agentName);
  }

  return buildDefaultProviderPrompt(agentName);
}

function buildGuidelines(tools: string[], extraGuidelines: string[]): string[] {
  const guidelines: string[] = [];
  const add = (item: string) => {
    if (!guidelines.includes(item)) {
      guidelines.push(item);
    }
  };

  if (tools.includes("bash") && tools.includes("grep")) {
    add("Prefer grep over bash for file search when it fits the task");
  }

  for (const item of extraGuidelines) {
    add(item);
  }

  return guidelines;
}

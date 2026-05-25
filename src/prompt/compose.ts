import type { PermissionMode, ThinkingLevel } from "../types.js";
import { buildAnthropicProviderPrompt } from "./provider-prompts/anthropic.js";
import { buildCodexProviderPrompt } from "./provider-prompts/codex.js";
import { buildDefaultProviderPrompt } from "./provider-prompts/default.js";
import { buildDeepSeekProviderPrompt } from "./provider-prompts/deepseek.js";
import { buildGeminiProviderPrompt } from "./provider-prompts/gemini.js";
import { buildGlmProviderPrompt } from "./provider-prompts/glm.js";
import { buildGptProviderPrompt } from "./provider-prompts/gpt.js";
import { buildKimiProviderPrompt } from "./provider-prompts/kimi.js";
import { buildEnvironmentPrompt, defaultToolNames, type EnvironmentPromptOptions } from "./environment.js";
import { buildRuntimePrompt } from "./runtime.js";
import type { SkillSummary } from "../skills/types.js";

export interface ComposeSystemPromptOptions extends EnvironmentPromptOptions {
  agentName?: string;
  guidelines?: string[];
  thinkingLevel?: ThinkingLevel;
  mode?: PermissionMode;
  skills?: SkillSummary[];
  memoryPrompt?: string;
  agentProfilePrompt?: string;
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

  return [
    providerPrompt,
    environmentPrompt,
    runtimePrompt,
    options.agentProfilePrompt,
    options.memoryPrompt,
  ].filter(Boolean).join("\n\n");
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
  const lowerModel = model.toLowerCase();

  if (provider === "anthropic" || model.startsWith("claude")) {
    return buildAnthropicProviderPrompt(agentName);
  }
  if (provider === "google" || model.startsWith("gemini")) {
    return buildGeminiProviderPrompt(agentName);
  }
  if (provider === "openai-codex" || model.includes("codex") || model.startsWith("gpt-5")) {
    return buildCodexProviderPrompt(agentName);
  }
  if (provider === "deepseek" || model.startsWith("deepseek")) {
    return buildDeepSeekProviderPrompt(agentName);
  }
  if (["moonshot-cn", "moonshot-intl", "kimi-for-coding"].includes(provider) || lowerModel.includes("kimi") || lowerModel.includes("k2.")) {
    return buildKimiProviderPrompt(agentName);
  }
  if (["zhipuai", "zhipuai-coding-plan", "zai", "zai-coding-plan"].includes(provider) || model.startsWith("glm")) {
    return buildGlmProviderPrompt(agentName);
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

  if (tools.includes("glob")) {
    add("Use glob for file discovery and project structure inspection; do not use bash ls/find for this unless glob cannot answer");
  }

  if (tools.includes("bash") && tools.includes("grep")) {
    add("Use grep for content search; do not run grep, rg, or ripgrep through bash");
  }

  if (tools.includes("question")) {
    add("When the user is explicitly discussing, brainstorming, or shaping an approach instead of asking for immediate execution, use the question tool for targeted clarification or preference choices when it would materially improve the discussion; do not use it for generic permission-to-proceed questions");
  }

  if (tools.includes("skill_search") && tools.includes("skill")) {
    add("Skills may provide specialized workflows. When a task appears to match a specialized workflow, call skill_search to find relevant skills, then call skill with the exact name to load the selected skill before applying it");
  }

  if (tools.includes("todo_write")) {
    add("Use todo_write to plan any task that needs three or more concrete steps before you start. Mark each item completed as soon as it is done; do not batch updates");
  }

  for (const item of extraGuidelines) {
    add(item);
  }

  return guidelines;
}

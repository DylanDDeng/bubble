import type { SystemPromptOptions } from "../system-prompt.js";
import type { ToolRegistryEntry } from "../types.js";

export function buildToolPromptOptions(tools: ToolRegistryEntry[]): Pick<SystemPromptOptions, "tools" | "toolSnippets" | "guidelines"> {
  const toolSnippets: Record<string, string> = {};
  const guidelines: string[] = [];

  for (const tool of tools) {
    if (tool.promptSnippet) {
      toolSnippets[tool.name] = tool.promptSnippet;
    }
    for (const guideline of tool.promptGuidelines ?? []) {
      guidelines.push(guideline);
    }
  }

  return {
    tools: tools.map((tool) => tool.name),
    toolSnippets,
    guidelines,
  };
}

import type { PermissionMode, ThinkingLevel } from "../types.js";

export interface RuntimePromptOptions {
  thinkingLevel?: ThinkingLevel;
  /**
   * Kept for API compatibility. Agent mode is no longer baked into the static
   * system prompt — mode changes are signalled via <system-reminder> injections
   * (see src/prompt/reminders.ts) so the base prompt stays stable for caching.
   */
  mode?: PermissionMode;
  guidelines?: string[];
}

const defaultGuidelines = [
  "Before editing or writing files, read them first if they exist",
  "Use edit for targeted changes to existing files; use write for creating new files",
  "Be concise in your responses",
  "Show file paths clearly when working with files",
  "Prefer structured search tools over bash for repository searches whenever possible",
  "Do not repeat near-identical searches when they are not producing new evidence",
  "When investigating configuration or security questions, stop once the relevant load path, storage path, and exposure path are identified",
  "Use the task tool for bounded investigative subproblems instead of letting the main loop churn on repeated exploratory searches",
];

export function buildRuntimePrompt(options: RuntimePromptOptions = {}): string {
  const thinkingLevel = options.thinkingLevel ?? "off";
  const guidelines = dedupe(defaultGuidelines, options.guidelines ?? []);

  return `Current thinking level: ${thinkingLevel}

Guidelines:
${guidelines.map((item) => `- ${item}`).join("\n")}`;
}

function dedupe(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const group of groups) {
    for (const item of group) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }

  return result;
}

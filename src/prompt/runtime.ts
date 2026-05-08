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
  "Inspect relevant files, command output, or runtime state before making claims about code behavior",
  "Separate confirmed facts from inference when the evidence is incomplete",
  "Prefer runtime and call-chain evidence over README text or configuration names for behavior questions",
  "Before editing or writing files, read them first if they exist",
  "Use edit for targeted changes to existing files; use write for creating new files",
  "Edit only the files required for the requested change",
  "Prefer structured search tools over bash for repository searches whenever possible",
  "Do not repeat near-identical searches when they are not producing new evidence",
  "When investigating configuration or security questions, stop once the relevant load path, storage path, and exposure path are identified",
  "Use the task tool for bounded investigative subproblems instead of letting the main loop churn on repeated exploratory searches",
  "After code edits, run the narrowest meaningful verification command or explain why verification is not possible",
  "When finishing a coding task, report what changed, where it changed, verification results, and remaining risk",
  "Be concise in your responses",
];

export function buildRuntimePrompt(options: RuntimePromptOptions = {}): string {
  const thinkingLevel = options.thinkingLevel ?? "off";
  const guidelines = dedupe(defaultGuidelines, options.guidelines ?? []);

  return `Current thinking level: ${thinkingLevel}

Execution protocol:
1. Understand the user's requested outcome and current constraints.
2. Inspect the relevant files or state before making claims or edits.
3. Choose the smallest coherent change that solves the actual problem.
4. Edit only the necessary files.
5. Verify with the narrowest meaningful command or runtime check when possible.
6. Finish with changed files, verification results, and unresolved risk.

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

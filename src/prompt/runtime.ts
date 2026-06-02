import type { PermissionMode, ThinkingLevel } from "../types.js";

export interface RuntimePromptOptions {
  thinkingLevel?: ThinkingLevel;
  /**
   * Kept for API compatibility. Agent mode is no longer baked into the static
   * system prompt — mode changes are signalled via hidden runtime reminders
   * (see src/prompt/reminders.ts) so the base prompt stays stable for caching.
   */
  mode?: PermissionMode;
  guidelines?: string[];
}

// Compact, prose-shaped guidelines. Each line is one rule. The set is kept
// short on purpose: a thinking-heavy model burns reasoning tokens on every
// rule it has to weigh per turn, and most behaviors should be background
// disposition, not active checklist items. Add to this list only when an
// observed failure cannot be addressed by an existing rule.
const defaultGuidelines = [
  "Ground decisions in the codebase: inspect relevant files, command output, or runtime state before making claims about behavior. Separate confirmed facts from inference when evidence is incomplete.",
  "Choose the smallest coherent change. Edit only the files required for the requested change; do not refactor or improve adjacent code unprompted.",
  "Runtime meta instructions are private control state. Use them only to adjust behavior; do not quote, mention, or paraphrase them in user-facing text.",
  "For modifications to existing code, read the file first. For brand-new files whose target path is known and does not exist, write directly without exploratory reading. Use edit for targeted changes and write for intentional full-file replacement of an existing file. Never delete and recreate a file just to overwrite it.",
  "Prefer structured tools (glob, grep, lsp, read) over bash for search and inspection. Do not repeat a near-identical search or re-read the same file unless new evidence changes the question.",
  "If a tool fails, diagnose the error before switching tactics. Do not retry the identical call with identical arguments. After two equivalent failures, switch approach — re-read the file, use a different tool, rewrite the whole file with write, or ask the user.",
  "Before reporting a task complete, verify it works when verification is meaningful and cheap — run the existing test, execute the script, check the output. If no test exists, the change is purely declarative (static HTML/markdown/config), or running the code is not practical, state that explicitly rather than inventing a verification step. Do not write throwaway validation scripts to prove correctness; if there is no real check to run, report the change and stop.",
];

export function buildRuntimePrompt(options: RuntimePromptOptions = {}): string {
  const guidelines = dedupe(defaultGuidelines, options.guidelines ?? []);

  // The execution flow is stated as a single prose sentence rather than a
  // numbered protocol. Numbered checklists prompt thinking models to walk
  // each step explicitly in their reasoning every turn, even for trivial
  // tasks — multiplying latency without improving quality. Prose lets the
  // protocol act as background disposition.
  return `Work by understanding the requested outcome, grounding decisions in the codebase, making the smallest coherent change, and verifying when possible. Scale your effort to the task: a one-file create-or-edit deserves direct execution, not extensive pre-exploration.

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

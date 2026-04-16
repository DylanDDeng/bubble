/**
 * Backward-compatible system prompt wrapper.
 */

import type { ThinkingLevel } from "./types.js";
import { composeSystemPrompt } from "./prompt/compose.js";

export interface SystemPromptOptions {
  /** Agent display name */
  agentName?: string;
  /** Configured provider id */
  configuredProvider?: string;
  /** Configured model name */
  configuredModel?: string;
  /** Full configured model id */
  configuredModelId?: string;
  /** Names of available tools */
  tools?: string[];
  /** One-line description for each tool */
  toolSnippets?: Record<string, string>;
  /** Extra guidelines */
  guidelines?: string[];
  /** Working directory to include in prompt */
  workingDir?: string;
  /** Current thinking level */
  thinkingLevel?: ThinkingLevel;
  /** Current date override */
  currentDate?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  return composeSystemPrompt(options);
}

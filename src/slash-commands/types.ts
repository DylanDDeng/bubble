import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";

export interface SlashCommandContext {
  agent: Agent;
  addMessage: (role: "user" | "assistant" | "error", content: string) => void;
  clearMessages: () => void;
  cwd: string;
  exit: () => void;
  sessionManager?: SessionManager;
  createProvider: (providerId: string, apiKey: string, baseURL: string) => Provider;
  openPicker: (mode: "model" | "key" | "provider" | "provider-add" | "login" | "logout", providerId?: string) => void;
  registry: ProviderRegistry;
  skillRegistry: SkillRegistry;
  bashAllowlist?: BashAllowlist;
  settingsManager?: SettingsManager;
  mcpManager?: McpManager;
}

/**
 * Return types for a slash command handler:
 *   - string | void: the string (if any) is displayed as an assistant message
 *   - { inject }: the content is sent to the agent as the user's next turn
 *     (used by MCP prompts that expand a template into a user message)
 */
export type SlashCommandOutput = string | void | { inject: string };

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandOutput>;
}

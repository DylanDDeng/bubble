import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { SkillRegistry } from "../skills/registry.js";

export interface SlashCommandContext {
  agent: Agent;
  addMessage: (role: "user" | "assistant" | "error", content: string) => void;
  clearMessages: () => void;
  cwd: string;
  exit: () => void;
  sessionManager?: SessionManager;
  createProvider: (providerId: string, apiKey: string, baseURL: string) => Provider;
  openPicker: (mode: "model" | "key" | "provider" | "login" | "logout") => void;
  registry: ProviderRegistry;
  skillRegistry: SkillRegistry;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: SlashCommandContext) => Promise<string | void>;
}

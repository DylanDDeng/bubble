import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";

export interface SlashCommandContext {
  agent: Agent;
  addMessage: (role: "user" | "assistant" | "error", content: string) => void;
  clearMessages: () => void;
  exit: () => void;
  sessionManager?: SessionManager;
  createProvider: (apiKey: string) => Provider;
  openPicker: (mode: "model" | "key") => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: SlashCommandContext) => Promise<string | void>;
}

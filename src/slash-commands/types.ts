import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";

export interface SlashCommandContext {
  agent: Agent;
  addMessage: (role: "user" | "assistant" | "error", content: string) => void;
  clearMessages: () => void;
  exit: () => void;
  sessionManager?: SessionManager;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: SlashCommandContext) => Promise<string | void>;
}

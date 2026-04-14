import type { SlashCommand } from "./types.js";

export const builtinSlashCommands: SlashCommand[] = [
  {
    name: "help",
    description: "Show available slash commands",
    async handler(args, ctx) {
      const { registry } = await import("./index.js");
      const lines = ["Available commands:"];
      for (const cmd of registry.list()) {
        lines.push(`  /${cmd.name} - ${cmd.description}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "quit",
    description: "Exit the application",
    async handler(args, ctx) {
      ctx.exit();
    },
  },
  {
    name: "clear",
    description: "Clear the current conversation history",
    async handler(args, ctx) {
      ctx.clearMessages();
      ctx.agent.messages = ctx.agent.messages.filter((m) => m.role === "system");
      return "Conversation cleared.";
    },
  },
  {
    name: "session",
    description: "Show current session information",
    async handler(args, ctx) {
      return `Session info not implemented yet.`;
    },
  },
  {
    name: "model",
    description: "Switch model (e.g. /model z-ai/glm-5.1)",
    async handler(args, ctx) {
      if (!args) {
        return "Usage: /model <model-id>";
      }
      // This is a lightweight override; in a full app you'd rebuild the agent
      (ctx.agent as any).model = args;
      return `Model switched to ${args}. Note: provider auth is unchanged.`;
    },
  },
  {
    name: "compact",
    description: "Manually compact the session context (placeholder)",
    async handler(args, ctx) {
      return "Compaction not implemented yet.";
    },
  },
];

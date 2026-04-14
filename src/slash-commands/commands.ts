import { UserConfig, normalizeModel, displayModel, maskKey, POPULAR_MODELS } from "../config.js";
import type { SlashCommand } from "./types.js";

const userConfig = new UserConfig();

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
    description: "Switch model. Use /model <id> or just /model to open picker.",
    async handler(args, ctx) {
      const current = ctx.agent.model;
      if (!args) {
        ctx.openPicker("model");
        return;
      }

      if (args === "--list" || args === "-l") {
        const lines = ["Popular models:"];
        for (const m of POPULAR_MODELS) {
          const marker = m === current ? "* " : "  ";
          lines.push(`${marker}${displayModel(m)}`);
        }
        lines.push("Run `/model <model-id>` to switch.");
        return lines.join("\n");
      }

      const next = normalizeModel(args);
      ctx.agent.model = next;
      userConfig.pushRecentModel(next);
      if (ctx.sessionManager) {
        ctx.sessionManager.setMetadata({ model: next });
      }
      return `Model switched to ${displayModel(next)}.`;
    },
  },
  {
    name: "key",
    description: "Set API key. Use /key <value> or just /key to open picker.",
    async handler(args, ctx) {
      if (!args) {
        ctx.openPicker("key");
        return;
      }
      userConfig.setApiKey(args);
      ctx.agent.setProvider(ctx.createProvider(args));
      return `API key updated to ${maskKey(args)} and active for the next message.`;
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

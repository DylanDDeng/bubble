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
    description: "Switch model (e.g. /model z-ai/glm-5.1). Use /model --list to see options.",
    async handler(args, ctx) {
      const current = ctx.agent.model;
      const currentDisplay = displayModel(current);

      if (!args) {
        const lines = [
          `Current model: ${currentDisplay}`,
          `Default model: ${displayModel(userConfig.getDefaultModel() || "openrouter/z-ai/glm-5.1")}`,
        ];
        const recent = userConfig.getRecentModels();
        if (recent.length > 0) {
          lines.push("Recent models:");
          for (const m of recent.slice(0, 5)) {
            const marker = m === current ? "* " : "  ";
            lines.push(`${marker}${displayModel(m)}`);
          }
        }
        lines.push("Run `/model --list` to see popular models.");
        return lines.join("\n");
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

      // Persist to session if available
      if (ctx.sessionManager) {
        ctx.sessionManager.setMetadata({ model: next });
      }

      return `Model switched to ${displayModel(next)}.`;
    },
  },
  {
    name: "key",
    description: "Set or view API key (e.g. /key sk-or-v1-xxx). Omit to see masked current key.",
    async handler(args, ctx) {
      if (!args) {
        const envKey = process.env.OPENROUTER_API_KEY;
        const configKey = userConfig.getApiKey();
        const lines = [];
        if (envKey) {
          lines.push(`Environment key: ${maskKey(envKey)}`);
        }
        if (configKey) {
          lines.push(`Config key: ${maskKey(configKey)}`);
        }
        if (!envKey && !configKey) {
          lines.push("No API key configured.");
          lines.push("Set one with: /key <your-openrouter-key>");
        }
        return lines.join("\n");
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

import { UserConfig, maskKey } from "../config.js";
import { encodeModel, displayModel, BUILTIN_PROVIDERS } from "../provider-registry.js";
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
    name: "provider",
    description: "Manage providers. /provider to open picker, /provider --add <id>, /provider --remove <id>, /provider --set <id>",
    async handler(args, ctx) {
      if (!args) {
        ctx.openPicker("provider");
        return;
      }

      const parts = args.trim().split(/\s+/);
      const flag = parts[0];
      const value = parts[1];

      if (flag === "--add" && value) {
        const builtin = BUILTIN_PROVIDERS.find((p) => p.id === value);
        if (!builtin) {
          const ids = BUILTIN_PROVIDERS.map((p) => p.id).join(", ");
          return `Unknown provider "${value}". Supported: ${ids}`;
        }
        ctx.openPicker("provider");
        return;
      }

      if (flag === "--remove" && value) {
        ctx.registry.removeProvider(value);
        return `Provider ${value} removed.`;
      }

      if (flag === "--set" && value) {
        const providers = ctx.registry.getConfigured();
        const p = providers.find((x) => x.id === value);
        if (!p) return `Provider ${value} is not configured.`;
        ctx.registry.setDefault(value);
        return `Default provider set to ${p.name}.`;
      }

      if (flag === "--list") {
        const providers = ctx.registry.getConfigured();
        const lines = ["Configured providers:"];
        for (const p of providers) {
          const marker = p.id === ctx.registry.getDefault()?.id ? "* " : "  ";
          lines.push(`${marker}${p.name} (${p.id}) ${p.enabled ? "" : "[disabled]"}`);
        }
        return lines.join("\n");
      }

      return `Usage: /provider [--add|--remove|--set|--list] <id>`;
    },
  },
  {
    name: "model",
    description: "Switch model. Use /model <id> or just /model to open picker.",
    async handler(args, ctx) {
      if (!args) {
        ctx.openPicker("model");
        return;
      }
      const defaultProvider = ctx.registry.getDefault()?.id || "openrouter";
      const next = args.includes(":") ? args : encodeModel(defaultProvider, args);
      ctx.agent.model = next;
      ctx.agent.providerId = defaultProvider;
      userConfig.pushRecentModel(next);
      if (ctx.sessionManager) {
        ctx.sessionManager.setMetadata({ model: next });
      }
      return `Model switched to ${displayModel(next)}.`;
    },
  },
  {
    name: "key",
    description: "Set API key for the current or a specific provider. /key to open picker.",
    async handler(args, ctx) {
      if (!args) {
        ctx.openPicker("key");
        return;
      }
      const provider = ctx.registry.getDefault();
      if (!provider) {
        return "No provider configured. Use /provider --add <id> first.";
      }
      ctx.registry.updateProviderKey(provider.id, args);
      ctx.agent.setProvider(ctx.createProvider(args, provider.baseURL));
      return `API key updated for ${provider.name} to ${maskKey(args)}.`;
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

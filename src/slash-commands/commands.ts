import { UserConfig, maskKey } from "../config.js";
import { encodeModel, decodeModel, displayModel, BUILTIN_PROVIDERS } from "../provider-registry.js";
import type { SlashCommand } from "./types.js";

const userConfig = new UserConfig();

function persistSelectedModel(model: string, ctx: Parameters<SlashCommand["handler"]>[1]) {
  userConfig.pushRecentModel(model);
  if (ctx.sessionManager) {
    ctx.sessionManager.setMetadata({ model });
  }
}

function switchToProviderModel(
  providerId: string,
  modelId: string,
  ctx: Parameters<SlashCommand["handler"]>[1]
) {
  const provider = ctx.registry.getConfigured().find((item) => item.id === providerId);
  if (!provider?.apiKey) {
    return false;
  }

  ctx.agent.setProvider(ctx.createProvider(provider.apiKey, provider.baseURL));
  ctx.agent.providerId = providerId;
  ctx.agent.model = encodeModel(providerId, modelId);
  persistSelectedModel(ctx.agent.model, ctx);
  return true;
}

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
        if (ctx.registry.getModelConfig().hasProvider(value)) {
          return `Provider ${value} is defined in ~/.my-agent/models.json. Please edit that file directly.`;
        }
        ctx.registry.removeProvider(value);
        return `Provider ${value} removed.`;
      }

      if (flag === "--set" && value) {
        const providers = ctx.registry.getConfigured();
        const p = providers.find((x) => x.id === value);
        if (!p) return `Provider ${value} is not configured.`;
        ctx.registry.setDefault(value);
        if (ctx.registry.getModelConfig().hasProvider(value)) {
          return `Default provider set to ${p.name}. Note: config is managed via ~/.my-agent/models.json.`;
        }
        return `Default provider set to ${p.name}.`;
      }

      if (flag === "--list") {
        const providers = ctx.registry.getConfigured();
        const lines = ["Configured providers:"];
        for (const p of providers) {
          const marker = p.id === ctx.registry.getDefault()?.id ? "* " : "  ";
          const source = ctx.registry.getModelConfig().hasProvider(p.id) ? " [models.json]" : "";
          const oauth = ctx.registry.getAuthStorage().has(p.id) ? " [oauth]" : "";
          lines.push(`${marker}${p.name} (${p.id}) ${p.enabled ? "" : "[disabled]"}${oauth}${source}`);
        }
        if (ctx.registry.getModelConfig().getLoadError()) {
          lines.push(`Warning: failed to load models.json: ${ctx.registry.getModelConfig().getLoadError()}`);
        }
        return lines.join("\n");
      }

      return `Usage: /provider [--add|--remove|--set|--list] <id>`;
    },
  },
  {
    name: "login",
    description: "OAuth login for supported providers. Usage: /login [openai-codex]",
    async handler(args, ctx) {
      const providerId = args?.trim() || "openai-codex";
      if (!ctx.registry.supportsOAuth(providerId)) {
        return `Unsupported OAuth provider: ${providerId}. Currently only 'openai-codex' is supported.`;
      }
      const { loginOpenAICodex } = await import("../oauth/openai-codex.js");
      const tokens = await loginOpenAICodex({
        onStatus: (msg) => ctx.addMessage("assistant", msg),
      });
      ctx.registry.getAuthStorage().set(providerId, {
        type: "oauth",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        idToken: tokens.idToken,
        accountId: tokens.accountId,
      });

      await ctx.registry.prepareProvider(providerId);
      ctx.registry.setDefault(providerId);

      const provider = ctx.registry.getConfigured().find((item) => item.id === providerId);
      const discoveredModels = provider ? await ctx.registry.listModels(provider) : [];
      const defaultModel = discoveredModels[0]?.id || ctx.registry.getDefaultModel(providerId);
      if (!defaultModel) {
        return `OpenAI Codex OAuth login succeeded, but no default model is configured for ${providerId}.`;
      }

      const switched = switchToProviderModel(providerId, defaultModel, ctx);
      if (!switched) {
        return `OpenAI Codex OAuth login succeeded, but the provider could not be activated. Tokens saved to ${ctx.registry.getAuthStorage().getPath()}`;
      }

      return `OpenAI Codex OAuth login successful. Switched to ${displayModel(ctx.agent.model)}. Account: ${tokens.accountId || "unknown"}. Tokens saved to ${ctx.registry.getAuthStorage().getPath()}`;
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
      const { providerId } = decodeModel(next);
      ctx.agent.model = next;
      ctx.agent.providerId = providerId || defaultProvider;
      persistSelectedModel(next, ctx);
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
      if (ctx.registry.getModelConfig().hasProvider(provider.id)) {
        return `API key for ${provider.name} is managed in ~/.my-agent/models.json. Please edit that file directly.`;
      }
      ctx.registry.updateProviderKey(provider.id, args);
      ctx.agent.setProvider(ctx.createProvider(args, provider.baseURL));
      ctx.agent.providerId = provider.id;
      return `API key updated for ${provider.name} to ${maskKey(args)}.`;
    },
  },
  {
    name: "logout",
    description: "Remove OAuth credentials for a provider. Usage: /logout [openai-codex]",
    async handler(args, ctx) {
      const providerId = args?.trim() || "openai-codex";
      if (!ctx.registry.getAuthStorage().has(providerId)) {
        return `No OAuth credentials found for ${providerId}.`;
      }
      ctx.registry.getAuthStorage().remove(providerId);

      const fallback = ctx.registry.getDefault();
      if (fallback?.apiKey) {
        const fallbackModel = ctx.registry.getDefaultModel(fallback.id);
        if (fallbackModel) {
          switchToProviderModel(fallback.id, fallbackModel, ctx);
          return `OAuth credentials for ${providerId} removed. Switched to ${fallback.name}.`;
        }
        ctx.agent.setProvider(ctx.createProvider(fallback.apiKey, fallback.baseURL));
        ctx.agent.providerId = fallback.id;
      } else if (ctx.agent.providerId === providerId) {
        ctx.agent.providerId = "";
      }

      return `OAuth credentials for ${providerId} removed.`;
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

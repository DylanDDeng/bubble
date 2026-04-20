import { UserConfig, maskKey } from "../config.js";
import { parseRule } from "../permissions/rule.js";
import type { RuleList, SettingsScope } from "../permissions/settings.js";
import { encodeModel, decodeModel, displayModel, BUILTIN_PROVIDERS, isUserVisibleProvider } from "../provider-registry.js";
import { getAvailableThinkingLevels, normalizeThinkingLevel } from "../provider-transform.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { formatLoadedSkill } from "../tools/skill.js";
import type { SlashCommand, SlashCommandContext } from "./types.js";

const VALID_SCOPES: SettingsScope[] = ["user", "project", "local"];
const VALID_LISTS: RuleList[] = ["allow", "deny"];

function isScope(value: string): value is SettingsScope {
  return (VALID_SCOPES as string[]).includes(value);
}

function isList(value: string): value is RuleList {
  return (VALID_LISTS as string[]).includes(value);
}

function handlePermissionsMutation(
  sub: "add" | "remove",
  tokens: string[],
  ctx: SlashCommandContext,
): string {
  if (!ctx.settingsManager) {
    return "No settings manager is attached to this session.";
  }

  const [scope, list, ...ruleParts] = tokens;
  if (!scope || !list || ruleParts.length === 0) {
    return `Usage: /permissions ${sub} <user|project|local> <allow|deny> <rule>\n`
      + `Example: /permissions ${sub} local allow Bash(git status)`;
  }
  if (!isScope(scope)) {
    return `Unknown scope "${scope}". Use one of: ${VALID_SCOPES.join(", ")}.`;
  }
  if (!isList(list)) {
    return `Unknown list "${list}". Use allow or deny.`;
  }

  const rule = ruleParts.join(" ");
  const parsed = parseRule(rule);
  if (!parsed.ok) {
    return `Invalid rule: ${parsed.error.message}`;
  }

  if (sub === "add") {
    const added = ctx.settingsManager.addRule(scope, list, rule);
    if (!added) return `Rule already present in ${scope} ${list}: ${rule}`;
    return `Added to ${scope} ${list}: ${rule}\n  → ${ctx.settingsManager.getPath(scope)}`;
  }

  const removed = ctx.settingsManager.removeRule(scope, list, rule);
  if (!removed) return `Rule not found in ${scope} ${list}: ${rule}`;
  return `Removed from ${scope} ${list}: ${rule}`;
}

const userConfig = new UserConfig();

function persistSelectedModel(model: string, ctx: Parameters<SlashCommand["handler"]>[1]) {
  userConfig.setDefaultModel(model);
  userConfig.setDefaultThinkingLevel(ctx.agent.thinking);
  userConfig.pushRecentModel(model);
  if (ctx.sessionManager) {
    ctx.sessionManager.setMetadata({ model, thinkingLevel: ctx.agent.thinking, reasoningEffort: ctx.agent.thinking });
    ctx.sessionManager.appendMarker("model_switch", model);
  }
}

function syncSystemPrompt(ctx: Parameters<SlashCommand["handler"]>[1], model: string) {
  const { providerId, modelId } = decodeModel(model);
  ctx.agent.setSystemPrompt(buildSystemPrompt({
    agentName: "Bubble",
    configuredProvider: providerId,
    configuredModel: displayModel(model),
    configuredModelId: model,
    thinkingLevel: ctx.agent.thinking,
    workingDir: ctx.cwd,
    skills: ctx.skillRegistry.summaries(),
  }));
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

  ctx.agent.thinking = normalizeThinkingLevel(
    ctx.agent.thinking,
    getAvailableThinkingLevels(providerId, modelId),
  );
  ctx.agent.setProvider(ctx.createProvider(providerId, provider.apiKey, provider.baseURL));
  ctx.agent.providerId = providerId;
  ctx.agent.model = encodeModel(providerId, modelId);
  syncSystemPrompt(ctx, ctx.agent.model);
  persistSelectedModel(ctx.agent.model, ctx);
  return true;
}

export const builtinSlashCommands: SlashCommand[] = [
  {
    name: "skills",
    description: "List available skills and any skill diagnostics",
    async handler(args, ctx) {
      const skills = ctx.skillRegistry.summaries();
      const diagnostics = ctx.skillRegistry.getDiagnostics();
      const lines: string[] = [];

      if (skills.length === 0) {
        lines.push("No skills available.");
      } else {
        lines.push("Available skills:");
        for (const skill of skills) {
          const tagSuffix = skill.tags && skill.tags.length > 0 ? ` [tags: ${skill.tags.join(", ")}]` : "";
          lines.push(`- ${skill.name}: ${skill.description}${tagSuffix}`);
        }
      }

      if (diagnostics.length > 0) {
        lines.push("", "Skill diagnostics:");
        for (const diagnostic of diagnostics) {
          const prefix = diagnostic.level === "error" ? "ERROR" : "WARN";
          const target = diagnostic.skillName ?? diagnostic.filePath ?? "skills";
          lines.push(`- ${prefix} ${target}: ${diagnostic.message}`);
        }
      }

      return lines.join("\n");
    },
  },
  {
    name: "skill",
    description: "Load a skill explicitly. Usage: /skill <name>",
    async handler(args, ctx) {
      const name = args.trim();
      if (!name) {
        return "Usage: /skill <name>";
      }

      const skill = ctx.skillRegistry.get(name);
      if (!skill) {
        const available = ctx.skillRegistry.summaries().map((item) => item.name).join(", ");
        return available
          ? `Unknown skill "${name}". Available skills: ${available}`
          : `Unknown skill "${name}". No skills are currently available.`;
      }

      ctx.sessionManager?.appendMarker("skill_activated", skill.meta.name);
      return formatLoadedSkill(skill);
    },
  },
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
      // Shut MCP stdio children down first; their stdout/stderr listeners
      // otherwise hold the Node event loop open even after ink unmounts.
      try {
        await ctx.mcpManager?.shutdown();
      } catch {
        // ignore — we're quitting anyway
      }
      ctx.exit();
      // Belt-and-braces: if anything else (raw-mode tty handle, pending
      // timer, etc.) still holds the loop, force-exit shortly after.
      setTimeout(() => process.exit(0), 100).unref();
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
    description: "Manage providers. /provider to switch, /provider --add [id] to add, /provider --remove <id>, /provider --set <id>",
    async handler(args, ctx) {
      if (!args) {
        ctx.openPicker("provider");
        return;
      }

      const parts = args.trim().split(/\s+/);
      const flag = parts[0];
      const value = parts[1];

      if (flag === "--add") {
        if (!value) {
          ctx.openPicker("provider-add");
          return;
        }

        const builtin = BUILTIN_PROVIDERS.find((p) => p.id === value && isUserVisibleProvider(p.id));
        if (!builtin) {
          const ids = BUILTIN_PROVIDERS.filter((p) => isUserVisibleProvider(p.id)).map((p) => p.id).join(", ");
          return `Unknown provider "${value}". Supported: ${ids}`;
        }
        ctx.registry.addProvider(value, "");
        ctx.registry.setDefault(value);
        ctx.openPicker("key", value);
        return;
      }

      if (flag === "--remove" && value) {
        if (ctx.registry.getModelConfig().hasProvider(value)) {
          return `Provider ${value} is defined in ~/.bubble/models.json. Please edit that file directly.`;
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
          return `Default provider set to ${p.name}. Note: config is managed via ~/.bubble/models.json.`;
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
    description: "OAuth login for supported providers. Usage: /login [openai]",
    async handler(args, ctx) {
      const providerId = args?.trim() || "openai";
      if (!providerId) {
        ctx.openPicker("login");
        return;
      }
      if (!ctx.registry.supportsOAuth(providerId)) {
        return `Unsupported OAuth provider: ${providerId}. Currently only 'openai' is supported.`;
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
      const defaultModel = discoveredModels[0]?.id || ctx.registry.getDefaultModel(providerId, "oauth");
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
        if (ctx.registry.getEnabled().length === 0) {
          return "No provider configured. Use /login or /provider --add <id> first.";
        }
        ctx.openPicker("model");
        return;
      }
      const defaultProvider = ctx.registry.getDefault()?.id || "openai";
      const next = args.includes(":") ? args : encodeModel(defaultProvider, args);
      const { providerId, modelId } = decodeModel(next);
      const targetProviderId = providerId || defaultProvider;

      await ctx.registry.prepareProvider(targetProviderId);
      const switched = switchToProviderModel(targetProviderId, modelId, ctx);
      if (!switched) {
        return `Provider ${targetProviderId} is not configured or has no active credentials.`;
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
      if (ctx.registry.getModelConfig().hasProvider(provider.id)) {
        return `API key for ${provider.name} is managed in ~/.bubble/models.json. Please edit that file directly.`;
      }
      ctx.registry.updateProviderKey(provider.id, args);
      ctx.agent.setProvider(ctx.createProvider(provider.id, args, provider.baseURL));
      ctx.agent.providerId = provider.id;
      return `API key updated for ${provider.name} to ${maskKey(args)}.`;
    },
  },
  {
    name: "logout",
    description: "Remove OAuth credentials for a provider. Usage: /logout [openai]",
    async handler(args, ctx) {
      const providerId = args?.trim() || "openai";
      if (!providerId) {
        ctx.openPicker("logout");
        return;
      }
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
        ctx.agent.setProvider(ctx.createProvider(fallback.id, fallback.apiKey, fallback.baseURL));
        ctx.agent.providerId = fallback.id;
      } else if (ctx.agent.providerId === providerId) {
        ctx.agent.providerId = "";
      }

      return `OAuth credentials for ${providerId} removed.`;
    },
  },
  {
    name: "plan",
    description: "Toggle plan mode on/off (Shift+Tab cycles through all permission modes)",
    async handler(args, ctx) {
      const next = ctx.agent.mode === "plan" ? "default" : "plan";
      ctx.agent.setMode(next);
      return next === "plan"
        ? "Entered plan mode. The assistant will investigate and propose a plan before making changes."
        : "Exited plan mode.";
    },
  },
  {
    name: "todos",
    description: "Show the current todo list. Use /todos clear to reset it.",
    async handler(args, ctx) {
      const sub = args.trim();
      if (sub === "clear") {
        const previous = ctx.agent.getTodos().length;
        if (previous === 0) {
          return "Todo list is already empty.";
        }
        ctx.agent.setTodos([]);
        return `Cleared ${previous} todo item${previous === 1 ? "" : "s"}.`;
      }

      const todos = ctx.agent.getTodos();
      if (todos.length === 0) {
        return "No todos yet. The assistant will create some when working on multi-step tasks.";
      }
      const glyph = (status: string) =>
        status === "completed" ? "✔" : status === "in_progress" ? "▶" : "○";
      const lines = ["Todos:"];
      for (const todo of todos) {
        const label = todo.status === "in_progress" ? (todo.activeForm || todo.content) : todo.content;
        lines.push(`  ${glyph(todo.status)} ${label}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "permissions",
    description: "Inspect or edit allow/deny rules. Subcommands: add <scope> <list> <rule>, remove <scope> <list> <rule>, clear (session allowlist), reload.",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "";

      if (sub === "add" || sub === "remove") {
        return handlePermissionsMutation(sub, tokens.slice(1), ctx);
      }

      if (sub === "clear") {
        if (!ctx.bashAllowlist) return "No approval controller is attached to this session.";
        const size = ctx.bashAllowlist.size();
        if (size === 0) return "Bash allowlist is already empty.";
        ctx.bashAllowlist.clear();
        return `Cleared ${size} bash prefix${size === 1 ? "" : "es"} from the session allowlist.`;
      }

      if (sub === "reload") {
        if (!ctx.settingsManager) return "No settings manager is attached to this session.";
        ctx.settingsManager.reload();
        return "Reloaded permission settings from disk.";
      }

      const lines: string[] = [];

      if (ctx.settingsManager) {
        const merged = ctx.settingsManager.getMerged();
        lines.push("Settings files:");
        lines.push(`  user:    ${ctx.settingsManager.getPath("user")}`);
        lines.push(`  project: ${ctx.settingsManager.getPath("project")}`);
        lines.push(`  local:   ${ctx.settingsManager.getPath("local")}`);

        if (merged.defaultMode) {
          lines.push("", `defaultMode: ${merged.defaultMode}`);
        }

        lines.push("", `Allow rules (${merged.ruleSet.allow.length}):`);
        if (merged.ruleSet.allow.length === 0) {
          lines.push("  (none)");
        } else {
          for (const r of merged.ruleSet.allow) lines.push(`  ${r.source}`);
        }

        lines.push("", `Deny rules (${merged.ruleSet.deny.length}):`);
        if (merged.ruleSet.deny.length === 0) {
          lines.push("  (none)");
        } else {
          for (const r of merged.ruleSet.deny) lines.push(`  ${r.source}`);
        }

        if (merged.diagnostics.length > 0) {
          lines.push("", "Diagnostics:");
          for (const d of merged.diagnostics) {
            lines.push(`  [${d.scope}] ${d.message}`);
          }
        }
      }

      if (ctx.bashAllowlist) {
        const entries = ctx.bashAllowlist.list();
        if (lines.length > 0) lines.push("");
        lines.push(`Session bash allowlist (${entries.length}):`);
        if (entries.length === 0) {
          lines.push('  (none) — approving "Yes, and don\'t ask again for <prefix>" adds entries here');
        } else {
          for (const prefix of entries) lines.push(`  ${prefix}`);
        }
      }

      if (lines.length === 0) {
        return "Permissions system not attached to this session.";
      }
      return lines.join("\n");
    },
  },
  {
    name: "mcp",
    description: "Manage MCP servers. Usage: /mcp [list|reconnect <name>]",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "list";

      if (!ctx.mcpManager) {
        return "MCP is not initialized for this session.";
      }

      if (sub === "reconnect") {
        const name = tokens[1];
        if (!name) return "Usage: /mcp reconnect <server-name>";
        const state = await ctx.mcpManager.reconnect(name);
        if (!state) return `Unknown MCP server: ${name}`;
        if (state.status.kind === "connected") {
          return `Reconnected ${name}. ${state.status.tools.length} tool${state.status.tools.length === 1 ? "" : "s"} available.`;
        }
        if (state.status.kind === "failed") {
          return `Failed to connect ${name}: ${state.status.error}`;
        }
        return `${name}: ${state.status.kind}`;
      }

      if (sub !== "list" && sub !== "") {
        return `Unknown /mcp subcommand "${sub}". Use /mcp list or /mcp reconnect <name>.`;
      }

      const states = ctx.mcpManager.getStates();
      if (states.length === 0) {
        return "No MCP servers configured. Add entries under `mcpServers` in ~/.bubble/settings.json or <cwd>/.bubble/settings.json.";
      }

      const lines: string[] = ["MCP servers:"];
      for (const state of states) {
        const transport = state.config.type;
        const scope = state.scope;
        if (state.status.kind === "connected") {
          const info = state.status.serverInfo ? ` ${state.status.serverInfo.name}@${state.status.serverInfo.version}` : "";
          const tn = state.status.tools.length;
          const pn = state.status.prompts.length;
          const counts = [`${tn} tool${tn === 1 ? "" : "s"}`];
          if (pn > 0) counts.push(`${pn} prompt${pn === 1 ? "" : "s"}`);
          lines.push(`  ✔ ${state.name} [${scope}/${transport}]${info} — ${counts.join(", ")}`);
          for (const tool of state.status.tools) {
            lines.push(`      · ${tool.name}${tool.description ? ` — ${tool.description.replace(/\s+/g, " ").slice(0, 80)}` : ""}`);
          }
          if (pn > 0) {
            lines.push(`    prompts (use as /mcp__${state.name}__<name>):`);
            for (const p of state.status.prompts) {
              const argSig = p.arguments?.length
                ? ` <${p.arguments.map((a) => (a.required ? a.name : `${a.name}?`)).join("> <")}>`
                : "";
              lines.push(`      · /mcp__${state.name}__${p.name}${argSig}${p.description ? ` — ${p.description.replace(/\s+/g, " ").slice(0, 70)}` : ""}`);
            }
          }
        } else if (state.status.kind === "failed") {
          lines.push(`  ✘ ${state.name} [${scope}/${transport}] — ${state.status.error}`);
        } else {
          lines.push(`  ○ ${state.name} [${scope}/${transport}] — disabled`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    name: "compact",
    description: "Manually compact the current session context",
    async handler(args, ctx) {
      if (!ctx.sessionManager) {
        return "Compaction requires session persistence. Start an interactive session first.";
      }

      const result = ctx.sessionManager.compact();
      if (!result.compacted) {
        return "Session is already compact enough.";
      }

      const systemMessage = ctx.agent.messages.find((message) => message.role === "system");
      ctx.clearMessages();
      ctx.agent.messages = [
        ...(systemMessage ? [systemMessage] : []),
        ...ctx.sessionManager.getMessages(),
      ];

      return `Compacted session context. Dropped ${result.droppedEntries ?? 0} log entries into a summary.`;
    },
  },
];

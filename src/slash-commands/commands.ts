import { UserConfig } from "../config.js";
import { formatContextUsage } from "../context/usage.js";
import { formatDiagnostics } from "../lsp/index.js";
import { normalizeNameForMCP } from "../mcp/name.js";
import { parseRule } from "../permissions/rule.js";
import type { RuleList, SettingsScope } from "../permissions/settings.js";
import { encodeModel, decodeModel, displayModel, BUILTIN_PROVIDERS, isUserVisibleProvider } from "../provider-registry.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "../provider-transform.js";
import { SessionManager } from "../session.js";
import type { CompactResult } from "../context/compact.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { normalizeSingleLine } from "../text-display.js";
import { formatRelativeTime } from "../tui/recent-activity.js";
import { HOOK_EVENT_NAMES, isHookEventName } from "../hooks/index.js";
import type { Provider, ThinkingLevel } from "../types.js";
import { isThinkingLevel } from "../variant/thinking-level.js";
import { normalizeInheritedThinkingLevel } from "../variant/variant-resolver.js";
import { collectUsageStatsBundle, formatStatsText } from "../stats/usage.js";
import {
  buildMemoryPrompt,
  getMemoryStatus,
  isMemoryDisabled,
  resetMemory,
  searchMemory,
  type MemoryScope,
} from "../memory/index.js";
import type { SlashCommand, SlashCommandContext } from "./types.js";
import type { UnifiedCommand } from "./unified.js";
import { feishuCommand } from "./feishu.js";
import { GROK_LOCAL_COMMAND_HELP } from "../external-runtime/grok-input-policy.js";
import {
  GROK_SUBSCRIPTION_PROVIDER_ID,
  isGrokSubscriptionProviderId,
} from "../external-runtime/grok-provider.js";
import { classifyExternalRuntimeBinding } from "../external-runtime/session-policy.js";

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

async function handleHooksCommand(args: string, ctx: SlashCommandContext): Promise<string> {
  const hooks = ctx.hookController;
  if (!hooks) return "Hooks controller is not attached to this session.";
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "status";

  if (sub === "status" || sub === "list" || sub === "") {
    return hooks.status();
  }

  if (sub === "reload") {
    hooks.reload();
    return `Reloaded hooks.\n\n${hooks.status()}`;
  }

  if (sub === "trust" && tokens[1] === "project") {
    return hooks.trustProject();
  }

  if (sub === "untrust" && tokens[1] === "project") {
    return hooks.untrustProject();
  }

  if (sub === "test") {
    const event = tokens[1];
    if (!isHookEventName(event)) {
      return `Usage: /hooks test <event> [target]\nEvents: ${HOOK_EVENT_NAMES.join(", ")}`;
    }
    return hooks.test(event, tokens.slice(2).join(" ") || undefined);
  }

  if (sub === "explain") {
    const event = tokens[1];
    if (!isHookEventName(event)) {
      return `Usage: /hooks explain <event>\nEvents: ${HOOK_EVENT_NAMES.join(", ")}`;
    }
    return hooks.explain(event);
  }

  if (sub === "logs") {
    const limit = Number(tokens[1] ?? 20);
    return hooks.logs(Number.isFinite(limit) ? limit : 20);
  }

  return "Usage: /hooks [status|reload|trust project|untrust project|test <event> [target]|explain <event>|logs [limit]]";
}

function persistSelectedModel(model: string, ctx: Parameters<SlashCommand["handler"]>[1]) {
  const userConfig = new UserConfig();
  userConfig.setDefaultModel(model);
  userConfig.setDefaultThinkingLevel(ctx.agent.thinking);
  userConfig.pushRecentModel(model);
  if (ctx.sessionManager) {
    ctx.sessionManager.updateMetadata({ model, thinkingLevel: ctx.agent.thinking, reasoningEffort: ctx.agent.thinking });
    ctx.sessionManager.appendMarker("model_switch", model);
  }
}

function syncSystemPrompt(ctx: Parameters<SlashCommand["handler"]>[1], model: string) {
  const { providerId, modelId } = decodeModel(model);
  const toolPromptOptions = typeof ctx.agent.getSystemPromptToolOptions === "function"
    ? ctx.agent.getSystemPromptToolOptions()
    : {};
  ctx.agent.setSystemPrompt(buildSystemPrompt({
    agentName: "Bubble",
    configuredProvider: providerId,
    configuredModel: displayModel(model),
    configuredModelId: model,
    thinkingLevel: ctx.agent.thinking,
    workingDir: ctx.cwd,
    ...toolPromptOptions,
    memoryPrompt: buildMemoryPrompt(ctx.cwd),
  }));
}

function formatMcpContextStatus(ctx: SlashCommandContext): string {
  const states = ctx.mcpManager?.getStates() ?? [];
  const lines = ["MCP"];
  if (!ctx.mcpManager || states.length === 0) {
    lines.push("- No MCP servers configured for this session.");
    lines.push("- Context impact: none.");
    return lines.join("\n");
  }

  for (const state of states) {
    if (state.status.kind === "connected") {
      lines.push(
        `- ${state.name} (${state.scope}): connected · ${state.status.tools.length} deferred tool${state.status.tools.length === 1 ? "" : "s"} · ${state.status.prompts.length} prompt${state.status.prompts.length === 1 ? "" : "s"}`,
      );
      continue;
    }
    if (state.status.kind === "failed") {
      lines.push(`- ${state.name} (${state.scope}): failed · ${state.status.error}`);
      continue;
    }
    lines.push(`- ${state.name} (${state.scope}): ${state.status.kind}`);
  }

  lines.push("- Context impact: MCP tool schemas are deferred. The prompt pays only a small deferred-tool reminder until tool_search unlocks a tool; unlocked MCP schemas then count under Tools.");
  lines.push("- MCP prompts are slash commands; they do not enter context until invoked.");
  return lines.join("\n");
}

function switchToProviderModel(
  providerId: string,
  modelId: string,
  ctx: Parameters<SlashCommand["handler"]>[1],
  thinkingLevel?: ThinkingLevel,
  preparedProvider?: Provider,
) {
  const provider = ctx.registry.getConfigured().find((item) => item.id === providerId);
  if (!provider?.apiKey) {
    return false;
  }

  ctx.agent.thinking = thinkingLevel !== undefined
    ? normalizeThinkingLevel(thinkingLevel, getAvailableThinkingLevels(providerId, modelId))
    : normalizeInheritedThinkingLevel(providerId, modelId, ctx.agent.thinking);
  ctx.agent.setProvider(preparedProvider ?? ctx.createProvider(providerId, provider.apiKey, provider.baseURL));
  ctx.agent.providerId = providerId;
  ctx.agent.model = encodeModel(providerId, modelId);
  syncSystemPrompt(ctx, ctx.agent.model);
  persistSelectedModel(ctx.agent.model, ctx);
  return true;
}

function parseModelArgs(args: string): { model?: string; thinkingLevel?: ThinkingLevel; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let model: string | undefined;
  let thinkingLevel: ThinkingLevel | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--reasoning-effort" || token === "--thinking") {
      const value = tokens[++index];
      if (!isThinkingLevel(value)) {
        return { error: `Invalid reasoning effort "${value ?? ""}".` };
      }
      thinkingLevel = value;
      continue;
    }
    if (!model) {
      model = token;
      continue;
    }
    return { error: `Unexpected model argument "${token}".` };
  }

  return { model, thinkingLevel };
}

function displaySelectedModel(model: string, thinkingLevel: ThinkingLevel): string {
  const label = displayModel(model);
  const { providerId, modelId } = decodeModel(model);
  const defaultLevel = providerId ? getDefaultThinkingLevel(providerId, modelId) : "off";
  return thinkingLevel === "off" || thinkingLevel === defaultLevel ? label : `${label} (${thinkingLevel})`;
}

function getGrokSessionId(ctx: SlashCommandContext): string | undefined {
  const binding = ctx.sessionManager?.getMetadata().externalRuntime;
  return binding && isGrokSubscriptionProviderId(binding.id) ? binding.sessionId : undefined;
}

function isGrokSessionActive(ctx: SlashCommandContext): boolean {
  return classifyExternalRuntimeBinding(
    ctx.sessionManager?.getMetadata().externalRuntime,
  ) === "grok";
}

function hasExternalRuntimeSession(ctx: SlashCommandContext): boolean {
  return classifyExternalRuntimeBinding(
    ctx.sessionManager?.getMetadata().externalRuntime,
  ) !== "none";
}

async function transitionGrokSessionToNative(ctx: SlashCommandContext): Promise<void> {
  if (!hasExternalRuntimeSession(ctx)) return;
  if (!ctx.transitionToNative) {
    throw new Error("Switching from Grok subscription to a native Bubble session is unavailable in this mode.");
  }
  const next = await ctx.transitionToNative();
  if (!next) {
    throw new Error("Bubble could not start a fresh native session.");
  }
  // Handlers below may persist provider/model metadata after the transition.
  // Keep those writes on the new native session rather than the old Grok log.
  ctx.sessionManager = next;
}

/**
 * Sign in to the Grok subscription as a native model provider (like ChatGPT
 * OAuth): browser PKCE against auth.x.ai, tokens in ~/.bubble/auth.json, and
 * grok models served through Bubble's own agent loop. An existing Grok CLI
 * login is imported so users who already ran `grok login` skip the browser.
 */
async function loginGrokSubscription(ctx: SlashCommandContext): Promise<string> {
  const providerId = "grok";
  const { loginGrok, importGrokCliCredentials } = await import("../oauth/grok.js");
  const storage = ctx.registry.getAuthStorage();

  const runBrowserLogin = async () => {
    const tokens = await loginGrok({
      onStatus: (msg) => ctx.addMessage("assistant", msg),
    });
    storage.set(providerId, {
      type: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
  };

  let importedExisting = false;
  if (!storage.has(providerId)) {
    const imported = importGrokCliCredentials();
    if (imported) {
      storage.set(providerId, {
        type: "oauth",
        accessToken: imported.accessToken,
        refreshToken: imported.refreshToken,
        expiresAt: imported.expiresAt,
      });
      importedExisting = true;
      ctx.addMessage("assistant", "Imported the existing Grok CLI sign-in.");
    }
  }
  const hadStoredLogin = storage.has(providerId);
  if (!hadStoredLogin) {
    await runBrowserLogin();
  }

  try {
    await ctx.registry.prepareProvider(providerId);
  } catch (error) {
    // Stored/imported credentials whose refresh token was revoked get exactly
    // one browser repair attempt; a failure right after browser login is real.
    if (!hadStoredLogin) throw error;
    ctx.addMessage("assistant", `Stored Grok credentials could not be refreshed (${error instanceof Error ? error.message : String(error)}). Signing in again…`);
    storage.remove(providerId);
    await runBrowserLogin();
    await ctx.registry.prepareProvider(providerId);
  }

  const provider = ctx.registry.getConfigured().find((item) => item.id === providerId);
  const defaultModel = ctx.registry.getDefaultModel(providerId, "oauth");
  if (!provider?.apiKey || !defaultModel) {
    return `Grok subscription login succeeded, but the provider could not be activated. Tokens saved to ${storage.getPath()}`;
  }

  // Complete every fallible preparation step before leaving a legacy
  // Grok-runtime session; commit only after the native switch succeeds.
  const preparedProvider = ctx.createProvider(providerId, provider.apiKey, provider.baseURL);
  await transitionGrokSessionToNative(ctx);

  const switched = switchToProviderModel(providerId, defaultModel, ctx, undefined, preparedProvider);
  if (!switched) {
    return `Grok subscription login succeeded, but the provider could not be activated. Tokens saved to ${storage.getPath()}`;
  }
  ctx.registry.setDefault(providerId);

  const via = importedExisting ? " (reused your Grok CLI sign-in)" : "";
  return `Grok subscription login successful${via}. Switched to ${displayModel(ctx.agent.model)}. Tokens saved to ${storage.getPath()}`;
}

async function logoutGrokSubscription(ctx: SlashCommandContext): Promise<string> {
  const storage = ctx.registry.getAuthStorage();
  const hadNativeLogin = storage.has("grok");
  storage.remove("grok");

  // Legacy cleanup: sessions bound to the old Grok ACP runtime, and the
  // isolated CLI profile's credentials.
  if (isGrokSessionActive(ctx) && ctx.externalRuntime && ctx.startFreshSession) {
    await ctx.externalRuntime.cancel(getGrokSessionId(ctx)).catch(() => undefined);
    await ctx.externalRuntime.dispose().catch(() => undefined);
    await ctx.externalRuntime.logout().catch(() => undefined);
    const freshSession = await ctx.startFreshSession();
    freshSession.clearExternalRuntimeMetadata();
    freshSession.appendMarker("runtime_switch", "native");
    ctx.sessionManager = freshSession;
    ctx.onExternalRuntimeChange?.(freshSession);
    return "Grok subscription logged out. Started a fresh native Bubble session.";
  }
  await ctx.externalRuntime?.logout().catch(() => undefined);

  if (!hadNativeLogin) {
    return "No Grok subscription login was stored on this device.";
  }
  return "Grok subscription logged out. Only this device's local login was removed.";
}

function parseMemoryScopeArgs(args: string): { scope: MemoryScope; rest: string; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let scope: MemoryScope = "project";
  const rest: string[] = [];
  for (const token of tokens) {
    if (token === "--global") {
      scope = "global";
      continue;
    }
    if (token === "--project") {
      scope = "project";
      continue;
    }
    rest.push(token);
  }
  return { scope, rest: rest.join(" ") };
}

async function handleMemoryCommand(args: string, ctx: Parameters<SlashCommand["handler"]>[1]): Promise<string> {
  const trimmed = args.trim();
  const [sub = "status", ...rest] = trimmed.split(/\s+/);

  if (!trimmed || sub === "status") {
    const status = getMemoryStatus(ctx.cwd);
    const lines = [
      "Memory status:",
      `  environment: ${status.environment}`,
      `  bubble home: ${status.bubbleHome}`,
      `  project root: ${status.paths.projectRoot}`,
      `  global root:  ${status.paths.globalRoot}`,
      `  startup pipeline: ${isMemoryDisabled() ? "disabled" : "enabled"}`,
      "",
      "Files:",
    ];
    for (const file of status.files) {
      lines.push(`  ${file.exists ? "present" : "missing"} ${file.label} (${file.bytes} bytes)`);
      lines.push(`    ${file.path}`);
    }
    lines.push("", "SQLite state:");
    lines.push(`  path: ${status.database.path}`);
    lines.push(`  stage1Outputs: ${status.database.stage1Outputs}`);
    lines.push(`  disabledThreads: ${status.database.disabledThreads}`);
    for (const job of status.database.jobs) {
      lines.push(`  job ${job.kind}/${job.jobKey}: ${job.status}`);
      if (job.lastError) lines.push(`    lastError: ${job.lastError}`);
    }
    return lines.join("\n");
  }

  if (sub === "add") {
    return "Manual memory writes are disabled. Bubble now follows the automatic startup memory pipeline.";
  }

  if (sub === "search") {
    const query = rest.join(" ").trim();
    if (!query) {
      return "Usage: /memory search <query>";
    }
    const results = searchMemory(ctx.cwd, query);
    if (results.length === 0) {
      return `No memory matches for "${query}".`;
    }
    const lines = [`Memory search results for "${query}":`];
    for (const result of results) {
      lines.push(`  ${result.scope} ${result.path}:${result.line}`);
      lines.push(`    ${result.text}`);
    }
    return lines.join("\n");
  }

  if (sub === "compact") {
    if (!ctx.runMemoryCompaction) {
      return "Memory compaction is not attached to this session.";
    }
    return await ctx.runMemoryCompaction();
  }

  if (sub === "summarize") {
    if (!ctx.runMemorySummary) {
      return "Memory summary is not attached to this session.";
    }
    const parsed = parseMemoryScopeArgs(rest.join(" "));
    if (parsed.rest) return "Usage: /memory summarize [--project|--global]";
    const result = await ctx.runMemorySummary(parsed.scope);
    if (ctx.agent.model) syncSystemPrompt(ctx, ctx.agent.model);
    return result;
  }

  if (sub === "refresh") {
    if (!ctx.runMemoryRefresh) {
      return "Memory refresh is not attached to this session.";
    }
    const parsed = parseMemoryScopeArgs(rest.join(" "));
    if (parsed.rest) return "Usage: /memory refresh [--project|--global]";
    const result = await ctx.runMemoryRefresh(parsed.scope);
    if (ctx.agent.model) syncSystemPrompt(ctx, ctx.agent.model);
    return result;
  }

  if (sub === "reset") {
    const result = resetMemory(ctx.cwd);
    if (ctx.agent.model) syncSystemPrompt(ctx, ctx.agent.model);
    return result;
  }

  return "Usage: /memory [status|search|compact|summarize|refresh|reset]";
}

const builtinSlashCommandEntries: SlashCommand[] = [
  {
    name: "skills",
    description: "Open the searchable skills picker",
    async handler(args, ctx) {
      ctx.openPicker("skill");
    },
  },
  {
    name: "help",
    description: "Show available slash commands",
    async handler(args, ctx) {
      if (hasExternalRuntimeSession(ctx)) {
        const grok = isGrokSessionActive(ctx);
        return [
          grok
            ? "Grok Subscription · workspace tools · Bubble approvals"
            : "Unsupported external runtime session · recovery-only mode",
          "Available commands:",
          ...GROK_LOCAL_COMMAND_HELP.map((command) => (
            `  ${command.usage} - ${command.description}`
          )),
        ].join("\n");
      }
      const { registry } = await import("./index.js");
      const lines = ["Available commands:"];
      for (const cmd of registry.list()) {
        lines.push(`  /${cmd.name} - ${cmd.description}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "memory",
    description: "Inspect and maintain Bubble's automatic persistent memory. Usage: /memory [status|search|compact|summarize|refresh|reset]",
    async handler(args, ctx) {
      return handleMemoryCommand(args, ctx);
    },
  },
  {
    name: "context",
    description: "Show current context window usage and breakdown",
    async handler(args, ctx) {
      return `${formatContextUsage(ctx.agent.getContextUsageSnapshot())}\n\n${formatMcpContextStatus(ctx)}`;
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
    name: "theme",
    description: "Pick the color theme. Usage: /theme [auto|light|dark]",
    async handler(args, ctx) {
      if (!ctx.setThemeMode || !ctx.getThemeMode || !ctx.getResolvedTheme) {
        return "Theme switching is only available inside the TUI.";
      }
      const arg = args.trim().toLowerCase();
      if (!arg) {
        ctx.openPicker("theme");
        return;
      }
      if (arg !== "auto" && arg !== "light" && arg !== "dark") {
        return "Usage: /theme [auto|light|dark]";
      }
      ctx.setThemeMode(arg);
      const resolved = arg === "auto" ? ctx.getResolvedTheme() : arg;
      return `Theme set to ${arg}${arg === "auto" ? ` (resolved to ${resolved})` : ""}.`;
    },
  },
  {
    name: "clear",
    description: "Clear the current conversation history",
    async handler(args, ctx) {
      ctx.agent.messages = ctx.agent.messages.filter((m) => m.role === "system" || m.role === "meta");
      // The resident history just shrank: drop the incremental usage anchor
      // too (same as /compact and /rewind), or budget accounting keeps
      // measuring against the pre-clear message count.
      ctx.agent.resetContextUsageAnchor();
      ctx.sessionManager?.appendMarker("conversation_clear", "");
      ctx.sessionManager?.clearTitleMetadata?.();
      if (ctx.agent.getTodos().length > 0) {
        ctx.agent.setTodos([]);
      }
      ctx.clearMessages();
    },
  },
  {
    name: "rewind",
    description: "Rewind conversation and/or file edits to before an earlier message. Usage: /rewind [n] [--code|--chat]",
    async handler(args, ctx) {
      const session = ctx.sessionManager;
      if (!session) {
        return "Rewind requires an active session.";
      }
      const turns = session.listUserTurns();
      if (turns.length === 0) {
        return "Nothing to rewind: no user messages in this session.";
      }

      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const flags = tokens.filter((token) => token.startsWith("--"));
      const positional = tokens.filter((token) => !token.startsWith("--"));
      const checkpoints = session.getCheckpoints();

      if (positional.length === 0) {
        if (ctx.openRewindPicker) {
          ctx.openRewindPicker();
          return;
        }
        const lines = ["Rewind points (oldest first):", ""];
        turns.forEach((turn, index) => {
          const time = new Date(turn.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const files = checkpoints.filesTouchedAt(turn.id).length;
          const fileNote = files > 0 ? `  [${files} file${files === 1 ? "" : "s"} changed]` : "";
          lines.push(`  ${index + 1}. ${time}  ${turn.preview}${fileNote}`);
        });
        lines.push(
          "",
          "Usage:",
          "  /rewind <n>         restore conversation AND files to just before message n",
          "  /rewind <n> --chat  conversation only",
          "  /rewind <n> --code  files only",
          "",
          "Note: only edits made by the edit/write tools are tracked; changes from",
          "bash commands are not. Checkpoints complement git, they don't replace it.",
        );
        return lines.join("\n");
      }

      const n = Number(positional[0]);
      if (!Number.isInteger(n) || n < 1 || n > turns.length) {
        return `Invalid rewind point "${positional[0]}". Run /rewind to list points (1-${turns.length}).`;
      }
      const target = turns[n - 1];
      const codeOnly = flags.includes("--code");
      const chatOnly = flags.includes("--chat") || flags.includes("--conversation");
      if (codeOnly && chatOnly) {
        return "Pick at most one of --code / --chat.";
      }

      // The "⏪" prefix is recognized by the TUIs: they rebuild the visible
      // transcript from the rewound agent.messages before showing this text.
      const lines: string[] = [
        codeOnly
          ? `Files restored to just before: ${target.preview}`
          : `⏪ Rewound to before: ${target.preview}`,
      ];

      if (!chatOnly) {
        const restore = await checkpoints.restoreTo(target.id);
        const touched = restore.restored.length + restore.deleted.length;
        if (touched === 0 && restore.failed.length === 0) {
          lines.push("Files: no tracked edits to undo.");
        } else {
          for (const file of restore.restored) lines.push(`Restored ${file}`);
          for (const file of restore.deleted) lines.push(`Deleted ${file} (created after this point)`);
          for (const file of restore.failed) lines.push(`FAILED to restore ${file}`);
        }
      }

      if (!codeOnly) {
        session.rewindToEntry(target.id);
        const head = ctx.agent.messages.filter((m) => m.role === "system" || m.role === "meta");
        ctx.agent.messages = [...head, ...session.getMessages()];
        ctx.agent.setTodos(session.getTodos());
        ctx.agent.resetContextUsageAnchor();

        if (ctx.fillComposer) {
          // Put the rewound message back into the input box for re-editing.
          ctx.fillComposer(target.text);
        } else {
          lines.push("", "Rewound message (copy to re-edit):", target.text);
        }
      }

      return lines.join("\n");
    },
  },
  {
    name: "session",
    description: "Browse recent sessions and resume one. /session to pick, /session --list to print",
    async handler(args, ctx) {
      const flag = args.trim();
      if (flag && flag !== "--list") {
        return "Usage: /session (open the session picker) or /session --list";
      }
      if (!flag && ctx.openSessionPicker) {
        ctx.openSessionPicker();
        return;
      }

      const summaries = SessionManager.summarizeSessionsForCwd(ctx.cwd);
      if (summaries.length === 0) {
        return "No sessions recorded for this project yet.";
      }
      const activeFile = ctx.sessionManager?.getSessionFile();
      const lines = ["Recent sessions:"];
      for (const summary of summaries.slice(0, 15)) {
        const current = summary.file === activeFile ? " (current)" : "";
        const title = normalizeSingleLine(summary.title || summary.preview || summary.name);
        const count = `${summary.messageCount} message${summary.messageCount === 1 ? "" : "s"}`;
        lines.push(`- ${title} — ${count}, ${formatRelativeTime(summary.mtime)} (${summary.name})${current}`);
      }
      if (summaries.length > 15) {
        lines.push(`- … and ${summaries.length - 15} more`);
      }
      lines.push("", "Resume one with: bubble --resume --session <name>");
      return lines.join("\n");
    },
  },
  {
    name: "provider",
    description: "Manage providers. /provider to switch, /provider --add [id] to add, /provider --remove <id>, /provider --set <id>",
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.openPicker("provider");
        return;
      }

      const parts = trimmed.split(/\s+/);
      const flag = parts[0];
      const value = parts[1];

      if (flag === "--add") {
        if (!value) {
          ctx.openPicker("provider-add");
          return;
        }
        if (isGrokSubscriptionProviderId(value)) {
          return "Grok Subscription is built in. Use /provider --set grok or /login grok to activate it.";
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
        if (isGrokSubscriptionProviderId(value)) {
          return "Grok Subscription is built in and cannot be removed. Use /logout grok to remove its local login.";
        }
        if (ctx.registry.getModelConfig().hasProvider(value)) {
          return `Provider ${value} is defined in ~/.bubble/models.json. Please edit that file directly.`;
        }
        ctx.registry.removeProvider(value);
        // Registry mutation without a model switch still changes the routing
        // world (design §1.6): refresh the routing menu in the system prompt.
        syncSystemPrompt(ctx, ctx.agent.model);
        return `Provider ${value} removed.`;
      }

      if (flag === "--set" && value) {
        if (isGrokSubscriptionProviderId(value)) {
          return loginGrokSubscription(ctx);
        }
        const providers = ctx.registry.getConfigured();
        const p = providers.find((x) => x.id === value);
        if (!p) return `Provider ${value} is not configured.`;
        await transitionGrokSessionToNative(ctx);
        ctx.registry.setDefault(value);
        if (ctx.registry.getModelConfig().hasProvider(value)) {
          return `Default provider set to ${p.name}. Note: config is managed via ~/.bubble/models.json.`;
        }
        return `Default provider set to ${p.name}.`;
      }

      if (flag === "--list") {
        const providers = ctx.registry.getConfigured();
        const grokActive = isGrokSessionActive(ctx);
        const lines = ["Available providers:"];
        for (const p of providers) {
          const marker = !grokActive && p.id === ctx.registry.getDefault()?.id ? "* " : "  ";
          const source = ctx.registry.getModelConfig().hasProvider(p.id) ? " [models.json]" : "";
          const oauth = ctx.registry.getAuthStorage().has(p.id) ? " [oauth]" : "";
          lines.push(`${marker}${p.name} (${p.id}) ${p.enabled ? "" : "[disabled]"}${oauth}${source}`);
        }
        if (!providers.some((provider) => provider.id === "grok")) {
          lines.push(`${grokActive ? "* " : "  "}Grok Subscription (grok) [not signed in — /login grok]`);
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
    description: "Login to OpenAI OAuth or Grok Subscription. Usage: /login [openai|grok]",
    async handler(args, ctx) {
      const providerId = args?.trim() || "openai";
      if (!providerId) {
        ctx.openPicker("login");
        return;
      }
      if (isGrokSubscriptionProviderId(providerId)) {
        return loginGrokSubscription(ctx);
      }
      if (!ctx.registry.supportsOAuth(providerId)) {
        return `Unsupported login provider: ${providerId}. Supported providers: 'openai' and 'grok'.`;
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

      const provider = ctx.registry.getConfigured().find((item) => item.id === providerId);
      const discoveredModels = provider ? await ctx.registry.listModels(provider) : [];
      const defaultModel = discoveredModels[0]?.id || ctx.registry.getDefaultModel(providerId, "oauth");
      if (!defaultModel) {
        return `OpenAI Codex OAuth login succeeded, but no default model is configured for ${providerId}.`;
      }
      if (!provider?.apiKey) {
        return `OpenAI Codex OAuth login succeeded, but the provider could not be activated. Tokens saved to ${ctx.registry.getAuthStorage().getPath()}`;
      }

      // Complete every fallible OAuth/provider/model preparation step before
      // leaving a Grok-bound session. The provider object is created once and
      // committed only after the fresh native session switch succeeds.
      const preparedProvider = ctx.createProvider(providerId, provider.apiKey, provider.baseURL);
      await transitionGrokSessionToNative(ctx);

      const switched = switchToProviderModel(providerId, defaultModel, ctx, undefined, preparedProvider);
      if (!switched) {
        return `OpenAI Codex OAuth login succeeded, but the provider could not be activated. Tokens saved to ${ctx.registry.getAuthStorage().getPath()}`;
      }
      ctx.registry.setDefault(providerId);

      return `OpenAI Codex OAuth login successful. Switched to ${displayModel(ctx.agent.model)}. Account: ${tokens.accountId || "unknown"}. Tokens saved to ${ctx.registry.getAuthStorage().getPath()}`;
    },
  },
  {
    name: "model",
    description: "Switch model. Use /model <id> [--reasoning-effort <level>] or just /model to open picker.",
    async handler(args, ctx) {
      if (!args) {
        if (hasExternalRuntimeSession(ctx)) {
          if (isGrokSessionActive(ctx)) {
            ctx.openPicker("model");
            return;
          }
          return "This external runtime manages its model and reasoning settings. Bubble's model picker is unavailable until you switch to a native session.";
        }
        if (ctx.registry.getEnabled().length === 0) {
          ctx.openPicker("model");
          return;
        }
        ctx.openPicker("model");
        return;
      }
      const parsed = parseModelArgs(args);
      if (parsed.error) {
        return parsed.error;
      }
      if (!parsed.model) {
        if (hasExternalRuntimeSession(ctx)) {
          if (isGrokSessionActive(ctx)) {
            ctx.openPicker("model");
            return;
          }
          return "This external runtime manages its model and reasoning settings. Bubble's model picker is unavailable until you switch to a native session.";
        }
        ctx.openPicker("model");
        return;
      }
      const explicitModelProvider = parsed.model.includes(":") ? parsed.model.split(":", 1)[0] : undefined;
      if (isGrokSessionActive(ctx) && (!explicitModelProvider || isGrokSubscriptionProviderId(explicitModelProvider))) {
        if (!ctx.externalRuntime) return "Grok Subscription runtime is unavailable.";
        const boundSessionId = getGrokSessionId(ctx);
        if (boundSessionId) await ctx.externalRuntime.hydrateSession(boundSessionId);
        const requestedModel = parsed.model.includes(":")
          ? parsed.model.split(":").slice(1).join(":")
          : parsed.model;
        const selection = await ctx.externalRuntime.setModel(requestedModel, parsed.thinkingLevel);
        const metadata = ctx.sessionManager?.getMetadata().externalRuntime;
        if (metadata && isGrokSubscriptionProviderId(metadata.id)) {
          ctx.sessionManager?.updateMetadata({
            externalRuntime: {
              ...metadata,
              modelId: selection.modelId,
              reasoningEffort: selection.reasoningEffort,
            },
          });
        }
        ctx.sessionManager?.appendMarker("model_switch", selection.modelId ?? requestedModel);
        ctx.sessionManager?.appendMarker("thinking_level_switch", selection.reasoningEffort);
        ctx.onExternalRuntimeChange?.(ctx.sessionManager);
        return `Grok model switched to ${selection.modelId ?? requestedModel}${selection.reasoningEffort !== "off" ? ` (${selection.reasoningEffort})` : ""}.`;
      }
      const defaultProvider = ctx.registry.getDefault()?.id || "openai";
      const next = parsed.model.includes(":") ? parsed.model : encodeModel(defaultProvider, parsed.model);
      const { providerId, modelId } = decodeModel(next);
      const targetProviderId = providerId || defaultProvider;

      await ctx.registry.prepareProvider(targetProviderId);
      const targetProvider = ctx.registry.getConfigured().find((item) => item.id === targetProviderId);
      if (!targetProvider?.apiKey) {
        return `Provider ${targetProviderId} is not configured or has no active credentials.`;
      }
      const preparedProvider = ctx.createProvider(
        targetProviderId,
        targetProvider.apiKey,
        targetProvider.baseURL,
      );
      await transitionGrokSessionToNative(ctx);
      switchToProviderModel(targetProviderId, modelId, ctx, parsed.thinkingLevel, preparedProvider);

      return `Model switched to ${displaySelectedModel(next, ctx.agent.thinking)}.`;
    },
  },
  {
    name: "logout",
    description: "Remove local login credentials. Usage: /logout [openai|grok]",
    async handler(args, ctx) {
      const providerId = args?.trim() || "openai";
      if (!providerId) {
        ctx.openPicker("logout");
        return;
      }
      if (isGrokSubscriptionProviderId(providerId)) {
        return logoutGrokSubscription(ctx);
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

      // No-fallback logout mutates the routing world without a model switch
      // (design §1.6): refresh the menu so it stops advertising the provider.
      syncSystemPrompt(ctx, ctx.agent.model);
      return `OAuth credentials for ${providerId} removed.`;
    },
  },
  {
    name: "plan",
    description: "Toggle plan mode on/off (Tab switches Build/Plan)",
    async handler(args, ctx) {
      const next = ctx.agent.mode === "plan" ? "default" : "plan";
      ctx.agent.setMode(next);
      return next === "plan"
        ? "Entered plan mode. The assistant will investigate and propose a plan before making changes."
        : "Exited plan mode.";
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
        ctx.lspService?.updateConfig(ctx.settingsManager.getMerged().lsp);
        ctx.lspService?.restart();
        return "Reloaded settings from disk.";
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
    name: "hooks",
    description: "Inspect and manage lifecycle hooks. Usage: /hooks [status|trust project|test <event>]",
    async handler(args, ctx) {
      return handleHooksCommand(args, ctx);
    },
  },
  {
    name: "lsp",
    description: "Inspect or restart language servers. Usage: /lsp [status|diagnostics|restart]",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "status";
      const lsp = ctx.lspService;
      if (!lsp) return "LSP is not initialized for this session.";

      if (sub === "restart") {
        ctx.settingsManager?.reload();
        ctx.lspService?.updateConfig(ctx.settingsManager?.getMerged().lsp);
        await lsp.restart();
        return "Restarted LSP servers.";
      }

      if (sub === "diagnostics") {
        const diagnostics = lsp.diagnostics();
        const entries = Object.entries(diagnostics).filter(([, issues]) => issues.length > 0);
        if (entries.length === 0) return "No LSP diagnostics.";
        const lines = ["LSP diagnostics:"];
        for (const [file, issues] of entries.slice(0, 10)) {
          lines.push(formatDiagnostics(file, issues, ctx.cwd));
        }
        if (entries.length > 10) lines.push(`... ${entries.length - 10} more file(s) with diagnostics`);
        return lines.join("\n");
      }

      if (sub !== "status" && sub !== "list" && sub !== "") {
        return `Unknown /lsp subcommand "${sub}". Use /lsp status, /lsp diagnostics, or /lsp restart.`;
      }

      if (lsp.isDisabled()) {
        return "LSPs have been disabled in settings.";
      }
      const statuses = lsp.status();
      if (statuses.length === 0) {
        return "LSPs will activate as files are read.";
      }
      const lines = ["LSP servers:"];
      for (const status of statuses) {
        const marker = status.status === "connected" ? "*" : status.status === "starting" ? "~" : "!";
        const suffix = status.message ? ` — ${status.message}` : "";
        lines.push(`  ${marker} ${status.id} ${status.root}${suffix}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "mcp",
    description: "Manage MCP servers. Usage: /mcp [list|tools <name>|reconnect <name>]",
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

      if (sub === "tools") {
        const name = tokens[1];
        if (!name) return "Usage: /mcp tools <server-name>";
        const state = ctx.mcpManager.getStates().find((s) => s.name === name);
        if (!state) return `Unknown MCP server: ${name}`;
        if (state.status.kind !== "connected") {
          return `${name} is not connected — no tools to list. Try /mcp reconnect ${name}.`;
        }
        const lines = [`Tools from ${name} (${state.status.tools.length}):`, ""];
        for (const tool of state.status.tools) {
          lines.push(`- \`${tool.name}\`${tool.description ? ` — ${tool.description.replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
        }
        return lines.join("\n");
      }

      if (sub !== "list" && sub !== "") {
        return `Unknown /mcp subcommand "${sub}". Use /mcp list, /mcp tools <name>, or /mcp reconnect <name>.`;
      }

      const states = ctx.mcpManager.getStates();
      if (states.length === 0) {
        return "No MCP servers configured. Add entries under `mcpServers` in ~/.bubble/settings.json or <cwd>/.bubble/settings.json.";
      }

      // Rendered as markdown in the TUI: each server is its own paragraph,
      // failures are bold + uppercase so they stand apart from healthy rows,
      // and tool lists stay collapsed behind /mcp tools <name>.
      const lines: string[] = ["MCP servers:"];
      for (const state of states) {
        const meta = `${state.scope}/${state.config.type}`;
        lines.push("");
        if (state.status.kind === "connected") {
          const info = state.status.serverInfo ? ` · ${state.status.serverInfo.name}@${state.status.serverInfo.version}` : "";
          const tn = state.status.tools.length;
          const pn = state.status.prompts.length;
          const counts = [`${tn} tool${tn === 1 ? "" : "s"}`];
          if (pn > 0) counts.push(`${pn} prompt${pn === 1 ? "" : "s"}`);
          lines.push(`✔ ${state.name} — connected · ${counts.join(" · ")} (${meta}${info})`);
          if (pn > 0) {
            const prompts = state.status.prompts.map((p) => `/${normalizeNameForMCP(p.name)}`);
            lines.push(`    prompts: ${prompts.join(", ")}`);
          }
        } else if (state.status.kind === "failed") {
          lines.push(`**✘ ${state.name} — UNABLE TO CONNECT** (${meta})`);
          lines.push(`    ${state.status.error.replace(/\s+/g, " ").slice(0, 200)}`);
          lines.push(`    retry: /mcp reconnect ${state.name}`);
        } else {
          lines.push(`○ ${state.name} — disabled (${meta})`);
        }
      }
      lines.push("");
      lines.push("Details: /mcp tools <name> · /mcp reconnect <name>");
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

      const preHook = await ctx.hookController?.runEvent({
        eventName: "PreCompact",
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionFile(),
        agentRole: "driver",
        target: "manual",
        payload: {
          kind: "manual",
          messageCount: ctx.agent.messages.length,
        },
      });
      if (preHook?.decision === "deny") {
        return preHook.reason ?? `Compaction blocked by hook ${preHook.sourceHookId ?? "<unknown>"}.`;
      }

      // Plan first so we can report "already compact" without spending a model
      // call, and so the LLM summarizer gets the exact set of evicted messages.
      const plan = ctx.sessionManager.getCompactionPlan();
      if (!plan) {
        await ctx.hookController?.runEvent({
          eventName: "PostCompact",
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionFile(),
          agentRole: "driver",
          target: "manual",
          payload: { kind: "manual", compacted: false },
        });
        return "Session is already compact enough.";
      }

      // Stream an LLM summary for high fidelity, reporting progress to the TUI.
      // On any failure (or empty output) fall back to the instant heuristic
      // compaction so /compact always makes progress.
      let result: CompactResult;
      try {
        ctx.compactionProgress?.({ phase: "collecting", streamedChars: 0 });
        let summary = "";
        try {
          summary = await ctx.agent.summarizeForCompaction(plan.oldMessages, (full) => {
            ctx.compactionProgress?.({ phase: "summarizing", streamedChars: full.length });
          });
        } catch {
          summary = "";
        }

        if (summary) {
          ctx.compactionProgress?.({ phase: "applying", streamedChars: summary.length });
          result = ctx.sessionManager.applyLLMCompaction(summary);
        } else {
          result = ctx.sessionManager.compact();
        }
      } finally {
        ctx.compactionProgress?.(null);
      }

      if (!result.compacted) {
        await ctx.hookController?.runEvent({
          eventName: "PostCompact",
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionFile(),
          agentRole: "driver",
          target: "manual",
          payload: {
            kind: "manual",
            compacted: false,
          },
        });
        return "Session is already compact enough.";
      }

      const systemMessage = ctx.agent.messages.find((message) => message.role === "system");
      ctx.agent.messages = [
        ...(systemMessage ? [systemMessage] : []),
        ...ctx.sessionManager.getMessages(),
      ];
      ctx.agent.resetContextUsageAnchor();

      const dropped = result.droppedEntries ?? 0;
      await ctx.hookController?.runEvent({
        eventName: "PostCompact",
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionFile(),
        agentRole: "driver",
        target: "manual",
        payload: {
          kind: "manual",
          compacted: true,
          droppedEntries: dropped,
        },
      });
      return `✓ Compaction complete · ${dropped} log entr${dropped === 1 ? "y" : "ies"} summarized`;
    },
  },
  {
    name: "stats",
    description: "Show recent model usage statistics",
    async handler(_args, ctx) {
      if (ctx.openStats) {
        ctx.openStats();
        return;
      }
      return formatStatsText(collectUsageStatsBundle());
    },
  },
  {
    name: "feedback",
    description: "Send feedback or report a bug to Bubble developers",
    async handler(args, ctx) {
      if (!ctx.openFeedback) {
        return "Feedback is only available in interactive TUI mode.";
      }
      ctx.openFeedback(args ?? "");
    },
  },
  feishuCommand,
];

/**
 * Public export — built-in commands tagged with `source: "builtin"` so the
 * registry and TUI can group them uniformly alongside MCP-derived commands.
 * Kept as a mapped projection to avoid adding the field to every object literal.
 */
export const builtinSlashCommands: UnifiedCommand[] = builtinSlashCommandEntries.map((cmd) => ({
  ...cmd,
  source: "builtin",
}));

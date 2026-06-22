#!/usr/bin/env bun

/**
 * Main entry point - assembles all layers and runs the agent.
 */

import chalk from "chalk";
import { Agent } from "./agent.js";
import { BudgetLedger } from "./agent/budget-ledger.js";
import { parseArgs, printHelp } from "./cli.js";
import { effectiveThemeModeForTerminal, shouldProbeTerminalTheme, UserConfig } from "./config.js";
import { createProviderInstance, createUnavailableProvider } from "./provider.js";
import { resolveConfiguredModel } from "./model-selection.js";
import { getDefaultThinkingLevel } from "./provider-transform.js";
import { ProviderRegistry, displayModel, encodeModel, decodeModel } from "./provider-registry.js";
import { SessionManager } from "./session.js";
import { createSessionTitleUpdater, type SessionTitleUpdater } from "./session-title.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { SkillRegistry } from "./skills/registry.js";
import { buildToolPromptOptions, createAllTools, type PlanController, type ToolSearchController } from "./tools/index.js";
import { FileStateTracker } from "./tools/file-state.js";
import { GoalStore } from "./goal/store.js";
import { PermissionAwareApprovalController } from "./approval/controller.js";
import { BashAllowlist } from "./approval/session-cache.js";
import type { ApprovalDecision, ApprovalRequest } from "./approval/types.js";
import { SettingsManager } from "./permissions/settings.js";
import { ExternalHookController } from "./hooks/index.js";
import { getLspService } from "./lsp/index.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpManager } from "./mcp/manager.js";
import type { PermissionMode, Message, PlanDecision } from "./types.js";
import { QuestionController } from "./question/index.js";
import {
  buildMemoryPrompt,
  formatMemoryStartupResult,
  recordMemoryCitations,
  runMemoryPhase2,
  runMemoryStartupPipeline,
  startMemoryStartupTask,
} from "./memory/index.js";
import { basename } from "node:path";
import { normalizeSingleLine, truncateVisual } from "./text-display.js";
import { BUBBLE_WORDMARK, type BubbleWordmarkTone } from "./tui/wordmark.js";
import {
  configureDebugTrace,
  summarizeAgentEventForTrace,
  summarizeTraceMessage,
  traceEvent,
} from "./debug-trace.js";

type TerminalTheme = "light" | "dark";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  if (process.argv.includes("-v") || process.argv.includes("--version")) {
    const { getCurrentVersion } = await import("./update/index.js");
    console.log(`v${getCurrentVersion()}`);
    process.exit(0);
  }

  if (args.command === "update") {
    const { runUpdateCommand } = await import("./update/index.js");
    const code = await runUpdateCommand({ checkOnly: args.checkOnly });
    process.exit(code);
  }

  if (args.command === "serve") {
    if (args.serveHost !== "feishu") {
      console.error(chalk.red("Usage: bubble serve --feishu [--setup | --kill-old | --dry-run]"));
      process.exit(2);
    }
    const { serveFeishu } = await import("./feishu/index.js");
    await serveFeishu({
      setup: args.setup,
      killOld: args.killOld,
      dryRun: args.dryRun,
    });
    return;
  }

  const userConfig = new UserConfig();
  const registry = new ProviderRegistry(userConfig);
  const skillRegistry = new SkillRegistry({
    cwd: args.cwd,
    skillPaths: userConfig.getSkillPaths(),
  });
  const printMode = args.print || !!args.prompt;

  // Resolve configured providers only; do not auto-inject OpenRouter as a startup default.
  const providers = registry.getConfigured();

  if (providers.length === 0) {
    if (printMode) {
      console.error(chalk.red("Error: No provider configured. Start interactive mode and use /login or /provider --add <id>."));
      process.exit(1);
    }
    console.log(chalk.dim("No provider configured yet. Start with /login for ChatGPT or /provider --add <id> for an API key."));
  }

  const defaultProvider = registry.getDefault();
  const unavailableProviderMessage = "No provider configured. Use /login for ChatGPT or /provider --add <id> before sending a prompt.";

  let sessionPromptCacheKey: string | undefined;

  const provider = defaultProvider
    ? createProviderInstance({
        providerId: defaultProvider.id,
        apiKey: defaultProvider.apiKey,
        baseURL: defaultProvider.baseURL,
        thinkingLevel: args.thinkingLevel,
        promptCacheKey: sessionPromptCacheKey,
        protocol: defaultProvider.protocol,
        openAICodexAuth: registry.createOpenAICodexAuthAdapter(defaultProvider.id),
      })
    : createUnavailableProvider(unavailableProviderMessage);
  const createProvider = (providerId: string, apiKey: string, baseURL: string) =>
    createProviderInstance({
      providerId,
      apiKey,
      baseURL,
      thinkingLevel: args.thinkingLevel,
      promptCacheKey: sessionPromptCacheKey,
      protocol: registry.getConfigured().find((provider) => provider.id === providerId)?.protocol,
      openAICodexAuth: registry.createOpenAICodexAuthAdapter(providerId),
    });
  const createProviderForRoute = async (route: { providerId: string; model: string }) => {
    const providerId = route.providerId;
    if (!providerId) {
      throw new Error(`Subagent route for model "${route.model}" did not include a provider.`);
    }
    if (registry.supportsOAuth(providerId) && registry.getAuthStorage().has(providerId)) {
      await registry.prepareProvider(providerId);
    }
    const target = registry.getConfigured().find((item) => item.id === providerId);
    if (!target?.enabled || !target.apiKey) {
      throw new Error(`Subagent route requires provider "${providerId}", but it is not configured or has no active credentials.`);
    }
    return createProvider(providerId, target.apiKey, target.baseURL);
  };

  let agentRef: Agent | undefined;
  const todoStore = {
    getTodos: () => agentRef?.getTodos() ?? [],
    setTodos: (todos: Parameters<Agent["setTodos"]>[0]) => agentRef?.setTodos(todos),
  };
  const planHandlerRef: { current?: (plan: string) => Promise<PlanDecision> } = {};
  const planController: PlanController = {
    getMode: () => agentRef?.mode ?? "default",
    requestApproval: (plan) =>
      planHandlerRef.current
        ? planHandlerRef.current(plan)
        : Promise.resolve({
            action: "reject",
            reason: "No interactive UI available to approve the plan.",
          }),
    setMode: (mode: PermissionMode) => {
      agentRef?.setMode(mode);
    },
  };
  const approvalHandlerRef: { current?: (req: ApprovalRequest) => Promise<ApprovalDecision> } = {};
  const questionController = new QuestionController();
  const bashAllowlist = new BashAllowlist();
  const settingsManager = new SettingsManager(args.cwd);
  for (const d of settingsManager.getMerged().diagnostics) {
    console.error(chalk.yellow(`[settings:${d.scope}] ${d.path}: ${d.message}`));
  }
  const hookController = new ExternalHookController({ cwd: args.cwd });
  for (const d of hookController.getConfig().diagnostics) {
    console.error(chalk.yellow(`[hooks:${d.scope}] ${d.path}: ${d.message}`));
  }
  const approvalController = new PermissionAwareApprovalController({
    getMode: () => agentRef?.mode ?? "default",
    handlerRef: approvalHandlerRef,
    bashAllowlist,
    cwd: args.cwd,
    getRuleSet: () => settingsManager.getMerged().ruleSet,
    externalHooks: hookController,
  });
  const toolSearchController: ToolSearchController = {
    listDeferred: () => agentRef?.listDeferredTools() ?? [],
    unlock: (names) => agentRef?.unlockDeferredTools(names),
  };
  const lspService = getLspService(args.cwd, settingsManager.getMerged().lsp);
  const fileStateTracker = new FileStateTracker(args.cwd);
  // Shared between the goal tools (model-facing get_goal/update_goal) and the
  // TUI's auto-continuation engine / status-line indicator.
  const goalStore = new GoalStore();
  const tools = createAllTools(args.cwd, skillRegistry, {
    todoStore,
    planController,
    approvalController,
    questionController: printMode ? undefined : questionController,
    toolSearchController,
    lspService,
    fileStateTracker,
    goalStore,
    // Lazy: sessionManager is resolved after tools are created.
    checkpoints: () => sessionManager?.getCheckpoints(),
  });

  // Bring up MCP servers (if any). Failures are captured per-server and never
  // block the rest of startup; /mcp surfaces status at runtime.
  const mcpLoaded = loadMcpConfig({ cwd: args.cwd });
  for (const d of mcpLoaded.diagnostics) {
    console.error(chalk.yellow(`[mcp:${d.scope}] ${d.path}: ${d.message}`));
  }
  const mcpManager = new McpManager({ servers: mcpLoaded.servers });
  if (mcpLoaded.servers.length > 0) {
    await mcpManager.start();
    // Only surface failures at startup. Successful connections would push the
    // welcome screen above the visible area on small terminals. /mcp shows the
    // full status.
    for (const state of mcpManager.getStates()) {
      if (state.status.kind === "failed") {
        console.error(chalk.yellow(`[mcp] ${state.name}: failed — ${state.status.error}`));
      }
    }
    tools.push(...mcpManager.getToolEntries());
  }

  // Expose MCP prompts as slash commands. Queried live at each lookup so
  // /mcp reconnect picks up new prompts without restarting the process.
  {
    const { registry: slashRegistry } = await import("./slash-commands/index.js");
    slashRegistry.addDynamicSource(() => mcpManager.getPromptCommands());
  }
  // Signal-based shutdown for Ctrl-C / kill. Normal /quit cleanup happens after
  // the TUI renderer has been destroyed, avoiding native teardown races.
  const shutdownMcp = async () => {
    try {
      await mcpManager.shutdown();
    } catch {
      // ignore — we're exiting anyway
    }
  };
  process.once("SIGINT", () => { void shutdownMcp().then(() => process.exit(130)); });
  process.once("SIGTERM", () => { void shutdownMcp().then(() => process.exit(143)); });

  // Session management:
  // - default: always start a fresh session
  // - --resume --session <name>: restore the named session
  // - --resume (no name): show interactive picker
  let sessionManager: SessionManager | undefined;
  let resumedExistingSession = false;
  // Resolved before any TUI render so picker and main TUI share the same value
  // and we only run OSC 11 once.
  let preResolvedTheme: TerminalTheme | undefined;

  if (args.resume && !args.sessionName) {
    const currentSessions = SessionManager.summarizeSessionsForCwd(args.cwd);
    const allSessions = SessionManager.listAllSessions();
    if (currentSessions.length === 0 && allSessions.length === 0) {
      console.log(chalk.dim("No previous sessions found — starting a fresh one."));
    } else {
      const themeConfig = userConfig.getTheme();
      if (shouldProbeTerminalTheme(themeConfig)) {
        const { detectTerminalTheme } = await import("./tui/detect-theme.js");
        preResolvedTheme = await detectTerminalTheme();
      } else {
        preResolvedTheme = themeConfig.mode === "light" ? "light" : "dark";
      }
      const pickerThemeMode = effectiveThemeModeForTerminal(themeConfig, preResolvedTheme);
      const pickerResolvedTheme = pickerThemeMode === "auto" ? preResolvedTheme : pickerThemeMode;
      const { runSessionPicker } = await import("./tui-ink/run-session-picker.js");
      const picked = await runSessionPicker({
        currentCwd: args.cwd,
        currentSessions,
        allSessions,
        resolvedTheme: pickerResolvedTheme,
        themeOverrides: themeConfig.overrides,
      });
      if (picked) {
        sessionManager = new SessionManager(picked);
        resumedExistingSession = true;
      }
    }
  } else if (args.resume) {
    sessionManager = SessionManager.resume(args.cwd, args.sessionName);
    resumedExistingSession = !!sessionManager;
  }

  if (!sessionManager) {
    sessionManager = args.sessionName && !args.resume
      ? SessionManager.create(args.cwd, args.sessionName)
      : SessionManager.createFresh(args.cwd);
    resumedExistingSession = false;
  }
  sessionPromptCacheKey = sessionManager.getOrCreatePromptCacheKey();

  // Model resolution:
  // 1. CLI flag  2. Session metadata  3. User-configured default model
  // No implicit built-in model fallback.
  const fallbackProviderId = defaultProvider?.id || "";
  const sessionModel = sessionManager?.getMetadata().model;
  const defaultModel = userConfig.getDefaultModel();
  const sessionThinkingLevel = sessionManager?.getMetadata().thinkingLevel;
  const configuredThinkingLevel = userConfig.getDefaultThinkingLevel();
  const normalizedConfiguredModel = resolveConfiguredModel({
    cliModel: args.model,
    sessionModel,
    defaultModel,
    fallbackProviderId,
  });
  const { providerId: effectiveProviderId, modelId: effectiveModelId } = normalizedConfiguredModel
    ? decodeModel(normalizedConfiguredModel)
    : { providerId: undefined, modelId: "" };
  let activeProviderId = effectiveProviderId || fallbackProviderId;
  if (registry.supportsOAuth(activeProviderId) && registry.getAuthStorage().has(activeProviderId)) {
    await registry.prepareProvider(activeProviderId);
  }
  const activeProvider = registry.getConfigured().find((p) => p.id === activeProviderId) || defaultProvider;
  const activeModel = activeProvider && effectiveModelId
    ? encodeModel(activeProviderId, effectiveModelId)
    : "";
  if (!activeModel && !activeProvider) {
    activeProviderId = "";
  }
  const initialThinkingLevel = activeModel
    ? (sessionThinkingLevel
      ?? args.thinkingLevel
      ?? configuredThinkingLevel
      ?? getDefaultThinkingLevel(activeProviderId, effectiveModelId))
    : (sessionThinkingLevel ?? args.thinkingLevel ?? configuredThinkingLevel ?? "off");
  const restoredTodos = sessionManager?.getTodos() ?? [];
  const initialMode: PermissionMode = args.mode ?? "default";
  const skillSummaries = skillRegistry.summaries();
  const memoryPrompt = buildMemoryPrompt(args.cwd);
  const systemPrompt = buildSystemPrompt({
    agentName: "Bubble",
    configuredProvider: activeProviderId || "none",
    configuredModel: activeModel ? displayModel(activeModel) : "none",
    configuredModelId: activeModel || "none",
    thinkingLevel: initialThinkingLevel,
    mode: initialMode,
    workingDir: args.cwd,
    ...buildToolPromptOptions(tools.filter((tool) => !tool.deferred)),
    memoryPrompt,
  });
  const traceInfo = configureDebugTrace({
    cwd: args.cwd,
    sessionFile: sessionManager?.getSessionFile(),
    provider: activeProviderId || "none",
    model: activeModel || "none",
    renderer: printMode ? "print" : "ink",
  });
  if (traceInfo.enabled) {
    traceEvent("run_start", {
      tracePath: traceInfo.path,
      rawEnabled: traceInfo.rawEnabled,
      resumed: resumedExistingSession,
      printMode,
      mode: initialMode,
      thinkingLevel: initialThinkingLevel,
      tools: tools.length,
      cwd: args.cwd,
    });
  }
  const budgetLedger = new BudgetLedger();
  let sessionTitleUpdater: SessionTitleUpdater | undefined;
  const agent = new Agent({
    provider: activeProvider
      ? createProvider(activeProviderId, activeProvider.apiKey, activeProvider.baseURL)
      : provider,
    providerId: activeProviderId || "",
    model: activeModel,
    sessionID: sessionManager?.getSessionFile(),
    tools,
    systemPrompt,
    temperature: 0.2,
    thinkingLevel: initialThinkingLevel,
    mode: initialMode,
    todos: restoredTodos,
    onMessageAppend: (message) => {
      if (!sessionManager) return;
      if (message.role === "system") return;
      // Runtime meta messages are ephemeral; don't persist them —
      // they will be re-injected as needed on resume based on the current mode.
      if (message.role === "meta") return;
      sessionManager.appendMessage(message);
      traceEvent("session_message_persisted", {
        message: summarizeTraceMessage(message),
      });
      sessionTitleUpdater?.handlePersistedMessage(message);
      if (message.role === "assistant") {
        recordMemoryCitations(args.cwd, message.content);
      }
    },
    onToolResult: (toolName, result) => {
      if (!sessionManager) return;
      if (toolName !== "skill" || result.isError) return;
      const match = result.content.match(/^Skill:\s+([^\n]+)$/m);
      if (match?.[1]) {
        sessionManager.appendMarker("skill_activated", match[1].trim());
      }
    },
    onTodosUpdate: (todos) => {
      sessionManager?.appendTodosSnapshot(todos);
    },
    onModeUpdate: (mode) => {
      sessionManager?.appendMarker("mode_switch", mode);
    },
    budgetLedger,
    skills: skillSummaries,
    memoryPrompt,
    fileStateTracker,
    agentCategories: userConfig.getAgentCategories(),
    subagents: userConfig.getSubagents(),
    providerFactory: createProviderForRoute,
    externalHooks: hookController,
  });
  agentRef = agent;
  if (sessionManager) {
    sessionTitleUpdater = createSessionTitleUpdater({
      sessionManager,
      complete: (messages, completeOptions) => agent.complete(messages, completeOptions),
    });
  }
  if (sessionManager) {
    sessionManager.updateMetadata({
      ...(agent.model ? { model: agent.model } : {}),
      cwd: args.cwd,
      thinkingLevel: agent.thinking,
      reasoningEffort: agent.thinking,
    });
  }
  await hookController.runEvent({
    eventName: "SessionStart",
    cwd: args.cwd,
    sessionId: sessionManager?.getSessionFile(),
    agentRole: "driver",
    target: "session",
    payload: {
      resumed: resumedExistingSession,
      printMode,
      providerId: agent.providerId,
      model: agent.apiModel,
    },
  });

  const flushMemory = async () => {
    // Codex-style memory runs at startup over historical rollouts. Exit should
    // not perform an ad-hoc extraction of the just-finished session.
  };
  const shutdownRuntime = async () => {
    await hookController.runEvent({
      eventName: "SessionEnd",
      cwd: args.cwd,
      sessionId: sessionManager?.getSessionFile(),
      agentRole: "driver",
      target: "session",
      payload: {
        providerId: agent.providerId,
        model: agent.apiModel,
      },
    });
    const results = await Promise.allSettled([
      flushMemory(),
      shutdownMcp(),
      lspService.shutdown(),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        // Shutdown is best-effort; never turn exit into a fatal error.
      }
    }
  };
  const runMemoryCompaction = async () =>
    formatMemoryStartupResult(await runMemoryStartupPipeline({
      cwd: args.cwd,
      complete: (messages, completeOptions) => agent.complete(messages, completeOptions),
      model: agent.apiModel,
    }));
  const runMemorySummary = async () => {
    const result = await runMemoryPhase2({
      cwd: args.cwd,
      complete: (messages, completeOptions) => agent.complete(messages, completeOptions),
      model: agent.apiModel,
    });
    return `Memory Phase 2 ${result.status}: selected ${result.selected}${result.reason ? ` (${result.reason})` : ""}.`;
  };
  const runMemoryRefresh = runMemoryCompaction;

  startMemoryStartupTask({
    cwd: args.cwd,
    complete: (messages, completeOptions) => agent.complete(messages, completeOptions),
    model: agent.apiModel,
  });

  if (activeModel && args.model && normalizedConfiguredModel === agent.model) {
    userConfig.pushRecentModel(agent.model);
  }

  // Restore session if requested
  if (resumedExistingSession && sessionManager) {
    const history = sessionManager.getMessages();
    if (history.length > 0) {
      agent.messages = [{ role: "system", content: systemPrompt }, ...history];
      // Reassigning agent.messages drops any runtime meta reminder injected during
      // construction. Re-inject if the agent is starting in plan mode.
      if (agent.mode === "plan") {
        agent.injectModeReminder();
      }
      console.log(chalk.dim(`Resumed session: ${sessionManager.getSessionFile()}`));
    }
  }

  try {
    // Print mode: single prompt, then exit
    if (args.print || args.prompt) {
      const prompt = args.prompt || (await readPipedStdin()) || "";
      if (!prompt) {
        console.error(chalk.red("Error: No prompt provided."));
        process.exit(1);
      }

      for await (const event of agent.run(prompt, args.cwd)) {
        traceEvent("print_agent_event", summarizeAgentEventForTrace(event));
        if (event.type === "text_delta") {
          process.stdout.write(event.content);
        } else if (event.type === "tool_start") {
          console.log(chalk.cyan(`\n[Tool: ${event.name}]`));
        } else if (event.type === "tool_end") {
          const color = event.result.isError ? chalk.red : chalk.dim;
          console.log(color(`[Result: ${event.result.content.slice(0, 200)}${event.result.content.length > 200 ? "..." : ""}]`));
        }
      }
      console.log();

      return;
    }

    const themeConfig = userConfig.getTheme();
    let detectedTheme: "light" | "dark" = "dark";
    if (preResolvedTheme) {
      detectedTheme = preResolvedTheme;
    } else if (shouldProbeTerminalTheme(themeConfig)) {
      // Probe before the renderer owns stdin. OSC 11 needs raw mode, and the
      // runtime renderer can consume the reply before startup code sees it.
      const { detectTerminalTheme } = await import("./tui/detect-theme.js");
      detectedTheme = await detectTerminalTheme();
    } else {
      detectedTheme = themeConfig.mode === "light" ? "light" : "dark";
    }
    const effectiveThemeMode = effectiveThemeModeForTerminal(themeConfig, detectedTheme);
    // In-place session switch for the /session picker: rebind every closure
    // that persists to the session (onMessageAppend, markers, title updater)
    // by reassigning the outer `sessionManager`, then replace the agent's
    // history the same way startup resume does.
    const switchSession = (sessionFile: string): { manager: SessionManager } | { error: string } => {
      try {
        const next = new SessionManager(sessionFile);
        const history = next.getMessages();
        sessionManager = next;
        sessionPromptCacheKey = next.getOrCreatePromptCacheKey();
        sessionTitleUpdater = createSessionTitleUpdater({
          sessionManager: next,
          complete: (messages, completeOptions) => agent.complete(messages, completeOptions),
        });
        next.updateMetadata({
          ...(agent.model ? { model: agent.model } : {}),
          cwd: args.cwd,
          thinkingLevel: agent.thinking,
          reasoningEffort: agent.thinking,
        });
        // Keep the live system/meta head (mode reminders survive the switch),
        // mirroring the /rewind history-replacement pattern.
        const head = agent.messages.filter((m) => m.role === "system" || m.role === "meta");
        agent.messages = [...head, ...history];
        agent.setTodos(next.getTodos());
        agent.resetContextUsageAnchor();
        return { manager: next };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };

    const commonOptions = {
      sessionManager,
      switchSession,
      createProvider,
      registry,
      skillRegistry,
      planHandlerRef,
      approvalHandlerRef,
      questionController,
      bashAllowlist,
      settingsManager,
      lspService,
      mcpManager,
      goalStore,
      hookController,
      flushMemory,
      runMemoryCompaction,
      runMemorySummary,
      runMemoryRefresh,
    };
    const { startStartupUpdateCheck } = await import("./update/index.js");
    const updateCheck = await startStartupUpdateCheck();
    const updateNotice = updateCheck.notice;
    const { runTui } = await import("./tui-ink/run.js");
    const summary = await runTui(agent, args, {
      ...commonOptions,
      themeMode: effectiveThemeMode,
      themeOverrides: themeConfig.overrides,
      detectedTheme,
      onThemeModeChange: (mode) => userConfig.setThemeMode(mode),
      updateNotice: updateNotice ?? undefined,
      updateNoticeRefresh: updateCheck.refreshed,
    });
    const exitWallMs = summary?.wallMs;

    if (sessionManager) {
      printExitSummary(sessionManager, {
        resumed: resumedExistingSession,
        theme: detectedTheme,
        wallMs: exitWallMs,
      });
    }
  } finally {
    traceEvent("run_shutdown_start");
    await shutdownRuntime();
    traceEvent("run_shutdown_end");
  }
}

function printExitSummary(
  sessionManager: SessionManager,
  options: { resumed: boolean; theme: TerminalTheme; wallMs?: number },
) {
  if (!process.stdout.isTTY) return;
  const sessionName = basename(sessionManager.getSessionFile());
  const sessionId = sessionName.replace(/\.jsonl$/, "");
  const title = truncateVisual(normalizeSingleLine(sessionManager.getMetadata().title ?? ""), 64);
  const sessionLabel = title || `${options.resumed ? "Session" : "New session"} - ${sessionId}`;
  const continueCommand = `bubble --resume --session ${sessionName}`;
  const colors = options.theme === "light"
    ? {
        markMuted: chalk.hex("#8C8C8C"),
        markStrong: chalk.hex("#1C1C1C"),
        markBrand: chalk.hex("#8B4A00"),
        label: chalk.hex("#6F7377"),
        value: chalk.hex("#171717").bold,
      }
    : {
        markMuted: chalk.hex("#9CA3AF"),
        markStrong: chalk.hex("#F4F4F5"),
        markBrand: chalk.hex("#F5A742"),
        label: chalk.hex("#808080"),
        value: chalk.hex("#EEEEEE").bold,
      };
  const label = (value: string) => colors.label(value.padEnd(10));
  const logoColor = (tone: BubbleWordmarkTone) => {
    switch (tone) {
      case "brand": return colors.markBrand;
      case "ink": return colors.markStrong;
      case "stone": return colors.markMuted;
      case "soft": return colors.label;
      case "caption": return colors.label;
    }
  };

  for (const line of BUBBLE_WORDMARK) {
    if (line.segments) {
      console.log(line.segments.map((segment) => logoColor(segment.tone)(segment.text)).join(""));
    } else {
      console.log(logoColor(line.tone ?? "caption")(line.text ?? ""));
    }
  }
  console.log();
  console.log(`${label("Session")}${colors.value(sessionLabel)}`);
  console.log(`${label("Continue")}${colors.value(continueCommand)}`);
  if (options.wallMs !== undefined) {
    console.log(`${label("Duration")}${colors.value(formatWallDuration(options.wallMs))}`);
  }
}

function formatWallDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const minutesRest = minutes % 60;
  return `${hours}h ${minutesRest}m ${seconds}s`;
}

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim() || undefined));
    process.stdin.resume();
  });
}

main()
  .then(() => {
    void exitAfterFlush(0);
  })
  .catch((err) => {
    console.error(chalk.red(`Fatal error: ${err.message}`));
    void exitAfterFlush(1);
  });

async function exitAfterFlush(code: number): Promise<void> {
  await Promise.all([
    flushStream(process.stdout),
    flushStream(process.stderr),
  ]);
  process.exit(code);
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

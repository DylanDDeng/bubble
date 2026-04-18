#!/usr/bin/env node

/**
 * Main entry point - assembles all layers and runs the agent.
 */

import chalk from "chalk";
import { Agent } from "./agent.js";
import { parseArgs, printHelp } from "./cli.js";
import { UserConfig } from "./config.js";
import { createProviderInstance, createUnavailableProvider } from "./provider.js";
import { getDefaultThinkingLevel } from "./provider-transform.js";
import { ProviderRegistry, displayModel, encodeModel, decodeModel } from "./provider-registry.js";
import { SessionManager } from "./session.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { SkillRegistry } from "./skills/registry.js";
import { createAllTools, type PlanController } from "./tools/index.js";
import type { AgentMode, Message, PlanDecision } from "./types.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    process.exit(0);
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

  const provider = defaultProvider
    ? createProviderInstance({
        providerId: defaultProvider.id,
        apiKey: defaultProvider.apiKey,
        baseURL: defaultProvider.baseURL,
        thinkingLevel: args.thinkingLevel,
      })
    : createUnavailableProvider(unavailableProviderMessage);
  const createProvider = (providerId: string, apiKey: string, baseURL: string) =>
    createProviderInstance({ providerId, apiKey, baseURL, thinkingLevel: args.thinkingLevel });

  let agentRef: Agent | undefined;
  const todoStore = {
    getTodos: () => agentRef?.getTodos() ?? [],
    setTodos: (todos: Parameters<Agent["setTodos"]>[0]) => agentRef?.setTodos(todos),
  };
  const planHandlerRef: { current?: (plan: string) => Promise<PlanDecision> } = {};
  const planController: PlanController = {
    requestApproval: (plan) =>
      planHandlerRef.current
        ? planHandlerRef.current(plan)
        : Promise.resolve({
            action: "reject",
            reason: "No interactive UI available to approve the plan.",
          }),
    setMode: (mode: AgentMode) => {
      agentRef?.setMode(mode);
    },
  };
  const tools = createAllTools(args.cwd, skillRegistry, { todoStore, planController });

  // Session management:
  // - default: always start a fresh session
  // - --resume: explicitly restore the latest or a named session
  let sessionManager = args.resume
    ? SessionManager.resume(args.cwd, args.sessionName)
    : undefined;
  let resumedExistingSession = !!sessionManager;
  if (!sessionManager) {
    sessionManager = args.sessionName && !args.resume
      ? SessionManager.create(args.cwd, args.sessionName)
      : SessionManager.createFresh(args.cwd);
    resumedExistingSession = false;
  }

  // Model resolution:
  // 1. Session metadata  2. User-configured default model  3. CLI flag
  // No implicit built-in model fallback.
  const fallbackProviderId = defaultProvider?.id || "";
  const sessionModel = sessionManager?.getMetadata().model;
  const configuredModel = sessionModel ?? userConfig.getDefaultModel() ?? args.model;
  const sessionThinkingLevel = sessionManager?.getMetadata().thinkingLevel;
  const configuredThinkingLevel = userConfig.getDefaultThinkingLevel();
  const normalizedConfiguredModel = configuredModel
    ? (configuredModel.includes(":")
      ? configuredModel
      : (fallbackProviderId ? encodeModel(fallbackProviderId, configuredModel) : ""))
    : "";
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
  const initialMode: AgentMode = args.mode ?? "default";
  const systemPrompt = buildSystemPrompt({
    agentName: "Bubble",
    configuredProvider: activeProviderId || "none",
    configuredModel: activeModel ? displayModel(activeModel) : "none",
    configuredModelId: activeModel || "none",
    thinkingLevel: initialThinkingLevel,
    mode: initialMode,
    workingDir: args.cwd,
    skills: skillRegistry.summaries(),
  });
  const agent = new Agent({
    provider: activeProvider
      ? createProvider(activeProviderId, activeProvider.apiKey, activeProvider.baseURL)
      : provider,
    providerId: activeProviderId || "",
    model: activeModel,
    tools,
    systemPrompt,
    temperature: 0.2,
    thinkingLevel: initialThinkingLevel,
    mode: initialMode,
    todos: restoredTodos,
    onMessageAppend: (message) => {
      if (!sessionManager) return;
      if (message.role === "system") return;
      // <system-reminder> injections are runtime/ephemeral; don't persist them —
      // they will be re-injected as needed on resume based on the current mode.
      if (message.role === "user" && (message as any).isMeta) return;
      sessionManager.appendMessage(message);
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
  });
  agentRef = agent;
  if (sessionManager) {
    sessionManager.setMetadata({
      ...(agent.model ? { model: agent.model } : {}),
      thinkingLevel: agent.thinking,
      reasoningEffort: agent.thinking,
    });
  }

  if (activeModel && args.model && normalizedConfiguredModel === agent.model) {
    userConfig.pushRecentModel(agent.model);
  }

  // Restore session if requested
  if (resumedExistingSession && sessionManager) {
    const history = sessionManager.getMessages();
    if (history.length > 0) {
      agent.messages = [{ role: "system", content: systemPrompt }, ...history];
      // Reassigning agent.messages drops any <system-reminder> we injected during
      // construction. Re-inject if the agent is starting in plan mode.
      if (agent.mode === "plan") {
        const { PLAN_MODE_ENTER_REMINDER } = await import("./prompt/reminders.js");
        agent.injectSystemReminder(PLAN_MODE_ENTER_REMINDER);
      }
      console.log(chalk.dim(`Resumed session: ${sessionManager.getSessionFile()}`));
    }
  }

  // Print mode: single prompt, then exit
  if (args.print || args.prompt) {
    const prompt = args.prompt || (await readPipedStdin()) || "";
    if (!prompt) {
      console.error(chalk.red("Error: No prompt provided."));
      process.exit(1);
    }

    for await (const event of agent.run(prompt, args.cwd)) {
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

  // Interactive mode: use Ink TUI
  const { runTui } = await import("./tui/run.js");
  runTui(agent, args, {
    sessionManager,
    createProvider,
    registry,
    skillRegistry,
    planHandlerRef,
  });
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

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});

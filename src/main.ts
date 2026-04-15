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
import { createAllTools } from "./tools/index.js";
import type { Message } from "./types.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  const userConfig = new UserConfig();
  const registry = new ProviderRegistry(userConfig);
  const printMode = args.print || !!args.prompt;

  // Ensure at least one provider is configured (backward compatible)
  let providers = registry.getConfigured();
  if (providers.length === 0) {
    const apiKey = args.apiKey || process.env.OPENROUTER_API_KEY || userConfig.getApiKey();
    if (apiKey) {
      registry.addProvider("openrouter", apiKey);
      providers = registry.getConfigured();
    }
  }

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
        reasoningEffort: args.reasoningEffort,
      })
    : createUnavailableProvider(unavailableProviderMessage);
  const createProvider = (providerId: string, apiKey: string, baseURL: string) =>
    createProviderInstance({ providerId, apiKey, baseURL, reasoningEffort: args.reasoningEffort });

  const tools = createAllTools(args.cwd);

  // Session management
  let sessionManager: SessionManager | undefined;
  if (!args.noSession) {
    sessionManager = SessionManager.create(args.cwd, args.sessionName);
  }

  // Model resolution fallback:
  // 1. CLI flag  2. Session metadata  3. Built-in default
  const fallbackProviderId = defaultProvider?.id || "openai";
  const fallbackModelId = registry.getDefaultModel(fallbackProviderId, defaultProvider?.authType) || args.model;
  const cliModel = args.model.includes(":") ? args.model : encodeModel(fallbackProviderId, fallbackModelId);
  const sessionModel = sessionManager?.getMetadata().model;
  const sessionReasoningEffort = sessionManager?.getMetadata().reasoningEffort;
  const effectiveModel = sessionModel ? sessionModel : cliModel;
  const { providerId: effectiveProviderId, modelId: effectiveModelId } = decodeModel(effectiveModel);
  const activeProviderId = effectiveProviderId || fallbackProviderId;
  if (registry.supportsOAuth(activeProviderId) && registry.getAuthStorage().has(activeProviderId)) {
    await registry.prepareProvider(activeProviderId);
  }
  const activeProvider = registry.getConfigured().find((p) => p.id === activeProviderId) || defaultProvider;
  const activeModel = encodeModel(activeProviderId, effectiveModelId);
  const initialThinkingLevel = sessionReasoningEffort
    ?? args.reasoningEffort
    ?? getDefaultThinkingLevel(activeProviderId, effectiveModelId);
  const systemPrompt = buildSystemPrompt({
    agentName: "Bubble",
    configuredProvider: activeProviderId,
    configuredModel: displayModel(activeModel),
    configuredModelId: activeModel,
    workingDir: args.cwd,
  });

  const agent = new Agent({
    provider: activeProvider
      ? createProvider(activeProviderId, activeProvider.apiKey, activeProvider.baseURL)
      : provider,
    providerId: activeProviderId,
    model: activeModel,
    tools,
    systemPrompt,
    temperature: 0.2,
    reasoningEffort: initialThinkingLevel,
    onMessageAppend: (message) => {
      if (sessionManager && message.role !== "system") {
        sessionManager.appendMessage(message);
      }
    },
  });
  if (sessionManager) {
    sessionManager.setMetadata({ model: agent.model, reasoningEffort: agent.reasoning });
  }

  if (cliModel === agent.model) {
    userConfig.pushRecentModel(agent.model);
  }

  // Restore session if requested
  if (sessionManager) {
    const history = sessionManager.getMessages();
    if (history.length > 0) {
      agent.messages = [{ role: "system", content: systemPrompt }, ...history];
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
  runTui(agent, args, sessionManager, createProvider, registry);
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

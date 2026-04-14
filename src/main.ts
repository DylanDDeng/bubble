/**
 * Main entry point - assembles all layers and runs the agent.
 */


import chalk from "chalk";
import { Agent } from "./agent.js";
import { parseArgs, printHelp } from "./cli.js";
import { UserConfig, normalizeModel, displayModel } from "./config.js";
import { createOpenRouterProvider } from "./provider.js";
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

  const apiKey = args.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("Error: OPENROUTER_API_KEY not set. Use -k or set the environment variable."));
    process.exit(1);
  }

  const userConfig = new UserConfig();

  const provider = createOpenRouterProvider({ apiKey, reasoning: args.reasoning });
  const tools = createAllTools(args.cwd);
  const systemPrompt = buildSystemPrompt({ workingDir: args.cwd });

  // Session management
  let sessionManager: SessionManager | undefined;
  if (!args.noSession) {
    sessionManager = SessionManager.create(args.cwd, args.sessionName);
  }

  // Model resolution fallback (opencode-style):
  // 1. CLI flag  2. Session metadata  3. User config default  4. Built-in default
  const cliModel = normalizeModel(args.model);
  const sessionModel = sessionManager?.getMetadata().model;
  const configDefault = userConfig.getDefaultModel();
  const effectiveModel = sessionModel
    ? normalizeModel(sessionModel)
    : cliModel;

  const agent = new Agent({
    provider,
    model: effectiveModel,
    tools,
    systemPrompt,
    temperature: 0.2,
    reasoning: args.reasoning,
    onMessageAppend: (message) => {
      if (sessionManager && message.role !== "system") {
        sessionManager.appendMessage(message);
      }
    },
  });

  // Sync model back to session metadata if it came from CLI or config default
  if (sessionManager) {
    sessionManager.setMetadata({ model: agent.model });
  }

  // Push to recent if it came from CLI flag
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

  if (configDefault && configDefault !== agent.model) {
    console.log(chalk.dim(`Default model in config: ${displayModel(configDefault)}`));
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
  runTui(agent, args, sessionManager);
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

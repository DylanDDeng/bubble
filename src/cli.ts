/**
 * CLI argument parsing.
 */

import type { AgentMode, ThinkingLevel } from "./types.js";
import { isThinkingLevel } from "./variant/thinking-level.js";

export interface CliArgs {
  model?: string;
  cwd: string;
  apiKey?: string;
  resume?: boolean;
  sessionName?: string;
  print?: boolean;
  prompt?: string;
  thinkingLevel?: ThinkingLevel;
  mode?: AgentMode;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    cwd: process.cwd(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--cwd":
        args.cwd = argv[++i];
        break;
      case "--api-key":
      case "-k":
        args.apiKey = argv[++i];
        break;
      case "--resume":
      case "-r":
        args.resume = true;
        break;
      case "--session":
        args.sessionName = argv[++i];
        break;
      case "--reasoning":
        args.thinkingLevel = "medium";
        break;
      case "--reasoning-effort": {
        const value = argv[++i];
        if (isThinkingLevel(value)) {
          args.thinkingLevel = value;
        }
        break;
      }
      case "--print":
      case "-p":
        args.print = true;
        break;
      case "--plan":
        args.mode = "plan";
        break;
      default:
        if (!arg.startsWith("-") && !args.prompt) {
          args.prompt = arg;
        }
        break;
    }
  }

  return args;
}

export function printHelp() {
  console.log(`
Usage: bubble [options] [prompt]

Options:
  -m, --model <model>      Model to use
  --cwd <dir>              Working directory (default: current)
  -k, --api-key <key>      API key for the active provider
  -r, --resume             Resume a previous session (latest by default)
  --session <name>         Session name to create or resume
  --reasoning              Enable reasoning mode at medium effort
  --reasoning-effort <l>   Set reasoning effort: off|minimal|low|medium|high|xhigh
  --plan                   Start in plan mode (read-only investigation; propose before executing)
  -p, --print              Non-interactive mode (single prompt)
  -h, --help               Show this help
`);
}

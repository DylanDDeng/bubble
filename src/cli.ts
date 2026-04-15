/**
 * CLI argument parsing.
 */

import type { ReasoningEffort } from "./types.js";

export interface CliArgs {
  model: string;
  cwd: string;
  apiKey?: string;
  resume?: boolean;
  sessionName?: string;
  noSession?: boolean;
  print?: boolean;
  prompt?: string;
  reasoningEffort?: ReasoningEffort;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: "z-ai/glm-5.1",
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
      case "--no-session":
        args.noSession = true;
        break;
      case "--reasoning":
        args.reasoningEffort = "medium";
        break;
      case "--reasoning-effort": {
        const value = argv[++i] as ReasoningEffort | undefined;
        if (value && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
          args.reasoningEffort = value;
        }
        break;
      }
      case "--print":
      case "-p":
        args.print = true;
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
  -m, --model <model>      Model to use (default: z-ai/glm-5.1)
  --cwd <dir>              Working directory (default: current)
  -k, --api-key <key>      OpenRouter API key (or set OPENROUTER_API_KEY env)
  -r, --resume             Resume last session
  --session <name>         Session name for persistence
  --no-session             Don't save session to disk
  --reasoning              Enable reasoning mode at medium effort
  --reasoning-effort <l>   Set reasoning effort: off|minimal|low|medium|high|xhigh
  -p, --print              Non-interactive mode (single prompt)
  -h, --help               Show this help
`);
}

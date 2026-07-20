/**
 * CLI argument parsing.
 */

import { THINKING_LEVELS, type PermissionMode, type ThinkingLevel } from "./types.js";
import { isThinkingLevel } from "./variant/thinking-level.js";

export type CliCommand = "default" | "serve" | "update";

export interface CliArgs {
  command: CliCommand;
  model?: string;
  cwd: string;
  apiKey?: string;
  resume?: boolean;
  sessionName?: string;
  print?: boolean;
  /** Print-mode output: plain (default) or a single JSON object on stdout. */
  outputFormat?: "plain" | "json";
  prompt?: string;
  thinkingLevel?: ThinkingLevel;
  mode?: PermissionMode;
  /** `serve` subcommand: which host to run. */
  serveHost?: "feishu";
  /** `serve` subcommand: force wizard. */
  setup?: boolean;
  /** `serve` subcommand: kill stale instance (non-interactive). */
  killOld?: boolean;
  /** `serve` subcommand: connect then exit. */
  dryRun?: boolean;
  /** `update` subcommand: only report whether an update exists, don't install. */
  checkOnly?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "default",
    cwd: process.cwd(),
  };

  // Subcommand detection: first non-flag argv item.
  let startIndex = 0;
  if (argv.length > 0 && !argv[0]!.startsWith("-")) {
    if (argv[0] === "serve") {
      args.command = "serve";
      startIndex = 1;
    } else if (argv[0] === "update" || argv[0] === "upgrade") {
      args.command = "update";
      startIndex = 1;
    }
  }

  for (let i = startIndex; i < argv.length; i++) {
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
      case "--output-format": {
        const value = argv[++i];
        if (value !== "plain" && value !== "json") {
          console.error(`Invalid --output-format: ${value ?? "(missing)"}. Expected plain or json.`);
          process.exit(1);
        }
        args.outputFormat = value;
        break;
      }
      case "--plan":
        args.mode = "plan";
        break;
      case "--accept-edits":
        // Backward-compatible no-op: Build mode now includes edit/write auto-approval.
        args.mode = "default";
        break;
      case "--dangerously-skip-permissions":
        args.mode = "bypassPermissions";
        break;
      case "--feishu":
        args.serveHost = "feishu";
        break;
      case "--setup":
        args.setup = true;
        break;
      case "--kill-old":
        args.killOld = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--check":
        args.checkOnly = true;
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
Usage:
  bubble [options] [prompt]              Start interactive TUI
  bubble update [--check]                Update to the latest version (alias: upgrade)
  bubble serve --feishu [options]        Run as a Feishu bot host

Options (default):
  -m, --model <model>      Model to use
  --cwd <dir>              Working directory (default: current)
  -k, --api-key <key>      API key for the active provider
  -r, --resume             Resume a previous session (latest by default)
  --session <name>         Session name to create or resume
  --reasoning              Enable reasoning mode at medium effort
  --reasoning-effort <l>   Set reasoning effort: ${THINKING_LEVELS.join("|")}
  --plan                   Start in plan mode (read-only investigation; propose before executing)
  --dangerously-skip-permissions
                           Enable bypass mode (auto-approve EVERY tool; disables all safety prompts)
  -p, --print              Non-interactive mode (single prompt)
  --output-format <fmt>    Print-mode output: plain (default) or json
                           (one JSON object on stdout: text, usage, num_turns)
  -v, --version            Print the installed version and exit
  -h, --help               Show this help

Options (update):
  --check                  Only report whether a newer version exists

Options (serve --feishu):
  --setup                  Force the wizard (scan QR + bind first scope)
  --kill-old               Kill any conflicting bubble instance for the same App ID
  --dry-run                Connect once, then exit (smoke test)
`);
}

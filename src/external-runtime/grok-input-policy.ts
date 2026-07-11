/** Commands that remain local while a Grok subscription session is bound. */
export const GROK_LOCAL_COMMAND_HELP = [
  { name: "help", usage: "/help", description: "Show commands" },
  { name: "model", usage: "/model", description: "Choose the Grok subscription model and reasoning effort" },
  { name: "provider", usage: "/provider", description: "Start a fresh native session and manage providers" },
  { name: "login", usage: "/login [openai|grok]", description: "Start a fresh session with that login" },
  { name: "logout", usage: "/logout grok", description: "Remove this device's local Grok login" },
  { name: "session", usage: "/session", description: "Browse sessions" },
  { name: "theme", usage: "/theme", description: "Pick the color theme" },
  { name: "feedback", usage: "/feedback", description: "Send product feedback" },
  { name: "quit", usage: "/quit", description: "Exit Bubble" },
  { name: "exit", usage: "/exit", description: "Exit Bubble" },
] as const;

export const GROK_LOCAL_SLASH_COMMANDS: ReadonlySet<string> = new Set(
  GROK_LOCAL_COMMAND_HELP.map((command) => command.name),
);

export type GrokInputDecision =
  | { kind: "prompt" }
  | { kind: "local_command"; command: string }
  | { kind: "blocked"; message: string };

export function grokSlashCommandName(input: string): string | undefined {
  const match = /^\s*\/([^\s/]+)/.exec(input);
  return match?.[1]?.toLowerCase();
}

export function isGrokLocalSlashCommand(command: string): boolean {
  return GROK_LOCAL_SLASH_COMMANDS.has(command.toLowerCase());
}

export function classifyGrokInput(input: {
  text: string;
  imageCount: number;
}): GrokInputDecision {
  if (input.imageCount > 0) {
    return {
      kind: "blocked",
      message: "This Grok runtime does not advertise image or attachment input support.",
    };
  }

  const command = grokSlashCommandName(input.text);
  if (command) {
    if (!isGrokLocalSlashCommand(command)) {
      return {
        kind: "blocked",
        message: `/${command} is not available in this Grok workspace session.`,
      };
    }
    if (command === "logout") {
      const argument = input.text.trim().split(/\s+/)[1]?.toLowerCase();
      if (argument !== "grok") {
        return {
          kind: "blocked",
          message: "Use /logout grok while Grok subscription chat is active.",
        };
      }
    }
    return { kind: "local_command", command };
  }

  if (input.text.trimStart().startsWith("/")) {
    return { kind: "blocked", message: "Unknown slash command." };
  }

  return { kind: "prompt" };
}

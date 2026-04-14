import type { SlashCommand, SlashCommandContext } from "./types.js";

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(cmd: SlashCommand) {
    this.commands.set(cmd.name, cmd);
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  list(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  async execute(input: string, ctx: SlashCommandContext): Promise<{ handled: boolean; result?: string }> {
    if (!input.startsWith("/")) return { handled: false };

    const spaceIndex = input.indexOf(" ");
    const name = spaceIndex === -1 ? input.slice(1) : input.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();

    const cmd = this.commands.get(name);
    if (!cmd) {
      return {
        handled: true,
        result: `Unknown command: /${name}. Use /help to see available commands.`,
      };
    }

    try {
      const result = await cmd.handler(args, ctx);
      return { handled: true, result: result ?? undefined };
    } catch (err: any) {
      return { handled: true, result: `Error: ${err.message || String(err)}` };
    }
  }
}

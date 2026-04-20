import type { SlashCommand, SlashCommandContext } from "./types.js";

/**
 * Dynamic source: called at lookup time to produce extra commands (e.g. MCP
 * prompts loaded from a server after connect). The registry only keeps the
 * callback — commands are never cached, so re-registering after a reconnect
 * just works.
 */
export type DynamicSource = () => SlashCommand[];

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private dynamicSources: DynamicSource[] = [];

  register(cmd: SlashCommand) {
    this.commands.set(cmd.name, cmd);
  }

  addDynamicSource(source: DynamicSource) {
    this.dynamicSources.push(source);
  }

  get(name: string): SlashCommand | undefined {
    const builtin = this.commands.get(name);
    if (builtin) return builtin;
    for (const source of this.dynamicSources) {
      for (const cmd of source()) {
        if (cmd.name === name) return cmd;
      }
    }
    return undefined;
  }

  list(): SlashCommand[] {
    const out: SlashCommand[] = [...this.commands.values()];
    for (const source of this.dynamicSources) {
      out.push(...source());
    }
    return out;
  }

  async execute(
    input: string,
    ctx: SlashCommandContext,
  ): Promise<{ handled: boolean; result?: string; inject?: string }> {
    if (!input.startsWith("/")) return { handled: false };

    const spaceIndex = input.indexOf(" ");
    const name = spaceIndex === -1 ? input.slice(1) : input.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();

    const cmd = this.get(name);
    if (!cmd) {
      const skill = ctx.skillRegistry.get(name);
      if (skill) {
        return {
          handled: true,
          result: `Skill "${skill.meta.name}": ${skill.meta.description}\nUse /${skill.meta.name} <your request> to run with this skill, or /skill ${skill.meta.name} to inspect it.`,
        };
      }
      return {
        handled: true,
        result: `Unknown command: /${name}. Use /help to see available commands.`,
      };
    }

    try {
      const output = await cmd.handler(args, ctx);
      if (output && typeof output === "object" && "inject" in output) {
        return { handled: true, inject: output.inject };
      }
      return { handled: true, result: typeof output === "string" ? output : undefined };
    } catch (err: any) {
      return { handled: true, result: `Error: ${err.message || String(err)}` };
    }
  }
}

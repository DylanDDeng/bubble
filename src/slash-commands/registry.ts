import type { SlashCommand, SlashCommandContext } from "./types.js";
import { asUnified, type CommandSource, type UnifiedCommand } from "./unified.js";

/**
 * Dynamic source: called at lookup time to produce extra commands (e.g. MCP
 * prompts loaded from a server after connect). The registry only keeps the
 * callback — commands are never cached, so re-registering after a reconnect
 * just works.
 *
 * Sources may return bare SlashCommand objects for backwards compatibility;
 * the registry treats unlabelled commands as source: "builtin". MCP's dynamic
 * source returns UnifiedCommand with source: "mcp".
 */
export type DynamicSource = () => SlashCommand[];

export class SlashCommandRegistry {
  private commands = new Map<string, UnifiedCommand>();
  private dynamicSources: DynamicSource[] = [];

  register(cmd: SlashCommand) {
    this.commands.set(cmd.name, asUnified(cmd, "builtin"));
  }

  addDynamicSource(source: DynamicSource) {
    this.dynamicSources.push(source);
  }

  get(name: string): UnifiedCommand | undefined {
    const builtin = this.commands.get(name);
    if (builtin) return builtin;
    for (const source of this.dynamicSources) {
      for (const cmd of source()) {
        if (cmd.name === name) return asUnified(cmd);
      }
    }
    return undefined;
  }

  list(): UnifiedCommand[] {
    const out: UnifiedCommand[] = [...this.commands.values()];
    for (const source of this.dynamicSources) {
      for (const cmd of source()) {
        out.push(asUnified(cmd));
      }
    }
    return out;
  }

  /**
   * Convenience filter used by UI code that wants to group by source
   * (e.g. builtin first, then mcp) without filtering in-line every time.
   */
  listBySource(source: CommandSource): UnifiedCommand[] {
    return this.list().filter((cmd) => cmd.source === source);
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
          result: `Skill "${skill.meta.name}": ${skill.meta.description}\nUse /${skill.meta.name} <your request> to run with this skill, or /skills to choose from the picker.`,
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

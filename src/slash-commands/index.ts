import { SlashCommandRegistry } from "./registry.js";
import { builtinSlashCommands } from "./commands.js";

export const registry = new SlashCommandRegistry();
for (const cmd of builtinSlashCommands) {
  registry.register(cmd);
}

export * from "./types.js";
export * from "./registry.js";

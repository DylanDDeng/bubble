/**
 * UnifiedCommand — a SlashCommand annotated with its source.
 *
 * Mirrors opencode's Command.Info.source field so consumers (TUI autocomplete,
 * /help, /mcp list) can group and label commands uniformly without knowing
 * where each one came from.
 *
 * Today only "builtin" and "mcp" are produced. A future "skill" source is
 * reserved in the type so we don't need another migration when skills move
 * into this abstraction.
 */

import type { SlashCommand } from "./types.js";

export type CommandSource = "builtin" | "mcp" | "skill";

export interface UnifiedCommand extends SlashCommand {
  source: CommandSource;
  /**
   * For source === "mcp" this is the server name. Used by the TUI to render
   * a ":mcp" badge and by /mcp list to group prompts under their server.
   */
  sourceLabel?: string;
}

export function isUnifiedCommand(cmd: SlashCommand): cmd is UnifiedCommand {
  return typeof (cmd as UnifiedCommand).source === "string";
}

/**
 * Wrap a bare SlashCommand into a UnifiedCommand, defaulting to builtin.
 * Used by the registry so callers that still pass plain SlashCommand objects
 * (tests, older code paths) keep working.
 */
export function asUnified(cmd: SlashCommand, source: CommandSource = "builtin"): UnifiedCommand {
  return isUnifiedCommand(cmd) ? cmd : { ...cmd, source };
}

/**
 * Stable source ordering used by UIs that group commands (e.g. the slash
 * autocomplete). Lower rank renders first.
 *
 *   builtin → skill → mcp
 *
 * Tuned so that "native" commands dominate the palette and user-installed
 * MCP servers appear after, echoing opencode's autocomplete layout.
 */
export function sourceRank(source: CommandSource | undefined): number {
  if (!source || source === "builtin") return 0;
  if (source === "skill") return 1;
  return 2; // "mcp"
}

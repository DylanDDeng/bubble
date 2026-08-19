import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand as TuiSlashCommand,
} from "@bubblebrain-ai/pi-tui";
import type { UnifiedCommand } from "../slash-commands/unified.js";
import type { SkillSummary } from "../skills/types.js";
import type { TuiMode } from "@bubblebrain-ai/pi-tui";

export interface ComposerAutocompleteSources {
  cwd: string;
  commands(): UnifiedCommand[];
  skills(): SkillSummary[];
  uiMode?(): TuiMode;
  fdPath?: string | null;
}

/**
 * Build the command surface in execution-priority order. The registry remains
 * live so MCP prompts that connect after startup appear on the next keypress.
 */
export function buildComposerSlashCommands(
  commands: UnifiedCommand[],
  skills: SkillSummary[],
  uiMode: TuiMode = "regular",
): TuiSlashCommand[] {
  const result = new Map<string, TuiSlashCommand>();
  const add = (command: TuiSlashCommand) => {
    if (!result.has(command.name)) result.set(command.name, command);
  };

  // Renderer-local commands execute before the shared registry.
  if (uiMode === "regular") {
    add({ name: "fullscreen", description: "Open the alternate-screen transcript view" });
  }

  for (const command of commands.filter((entry) => entry.source === "builtin")) {
    add({ name: command.name, description: command.description });
  }

  for (const skill of skills) {
    const source = skill.source ? ` · ${skill.source}` : "";
    add({
      name: skill.name,
      argumentHint: "<request>",
      submitOnSelect: false,
      description: `[skill${source}] ${skill.description}`,
    });
  }

  for (const command of commands.filter((entry) => entry.source !== "builtin")) {
    const source = command.sourceLabel ? `mcp:${command.sourceLabel}` : command.source;
    add({ name: command.name, description: `[${source}] ${command.description}` });
  }

  return [...result.values()];
}

/** A live adapter around pi-tui's command/file completion implementation. */
export class ComposerAutocompleteProvider implements AutocompleteProvider {
  constructor(private readonly sources: ComposerAutocompleteSources) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    return this.delegate().getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.delegate().applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.delegate().shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }

  private delegate(): CombinedAutocompleteProvider {
    return new CombinedAutocompleteProvider(
      buildComposerSlashCommands(
        this.sources.commands(),
        this.sources.skills(),
        this.sources.uiMode?.() ?? "regular",
      ),
      this.sources.cwd,
      this.sources.fdPath ?? null,
    );
  }
}

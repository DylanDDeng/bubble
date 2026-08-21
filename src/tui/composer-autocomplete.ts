import {
  type AutocompleteArgumentSuggestions,
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand as TuiSlashCommand,
} from "@bubblebrain-ai/pi-tui";
import type { UnifiedCommand } from "../slash-commands/unified.js";
import type { SkillSummary } from "../skills/types.js";
import type { TuiMode } from "@bubblebrain-ai/pi-tui";
import { encodeModel, type ModelInfo, type ProviderProfile } from "../provider-registry.js";
import {
  getAvailableThinkingLevels,
  isThinkingToggleModel,
  normalizeThinkingLevel,
} from "../provider-transform.js";
import type { ThinkingLevel } from "../types.js";
import {
  discoverModelProviderGroups,
  getVisibleModelProviders,
  localModelsForProvider,
  type ModelPickerRegistry,
  type ModelProviderGroup,
} from "./model-picker-data.js";

export interface ComposerAutocompleteSources {
  cwd: string;
  commands(): UnifiedCommand[];
  skills(): SkillSummary[];
  uiMode?(): TuiMode;
  registry?: ModelPickerRegistry;
  thinkingLevel?(): ThinkingLevel;
  onModelSuggestionsChanged?(): void;
  fdPath?: string | null;
}

type ModelCompletionSource = (
  argumentPrefix: string,
) => AutocompleteArgumentSuggestions | AutocompleteItem[] | null;

const MODEL_COMMAND_PREFIX = "/model ";
const REASONING_EFFORT_SEPARATOR = " --reasoning-effort ";

const EFFORT_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "no reasoning effort",
  minimal: "fastest reasoning",
  low: "light reasoning",
  medium: "balanced reasoning",
  high: "deeper reasoning",
  xhigh: "extra high reasoning",
  max: "maximum provider effort",
  ultra: "maximum effort with delegation",
};

type ModelSelection = {
  provider: ProviderProfile;
  model: ModelInfo;
  value: string;
  levels: ThinkingLevel[];
};

function selectableModels(groups: ModelProviderGroup[]): ModelSelection[] {
  const seen = new Set<string>();
  const selections: ModelSelection[] = [];
  for (const { provider, models } of groups) {
    for (const model of models) {
      const value = encodeModel(provider.id, model.id);
      if (seen.has(value)) continue;
      seen.add(value);
      const declaredLevels = model.reasoningLevels ?? getAvailableThinkingLevels(provider.id, model.id);
      selections.push({
        provider,
        model,
        value,
        levels: declaredLevels.length > 0 ? declaredLevels : ["off"],
      });
    }
  }
  return selections;
}

function preferredThinkingLevel(selection: ModelSelection, current: ThinkingLevel): ThinkingLevel {
  if (selection.levels.includes(current)) return current;
  if (
    selection.model.defaultReasoningLevel &&
    selection.levels.includes(selection.model.defaultReasoningLevel)
  ) {
    return selection.model.defaultReasoningLevel;
  }
  return normalizeThinkingLevel(current, selection.levels);
}

function effortPhase(
  selections: ModelSelection[],
  argumentPrefix: string,
): { selection: ModelSelection; query: string } | null {
  const separatorIndex = argumentPrefix.indexOf(REASONING_EFFORT_SEPARATOR);
  if (separatorIndex < 0) return null;
  const modelValue = argumentPrefix.slice(0, separatorIndex);
  const selection = selections.find((candidate) => candidate.value === modelValue);
  if (!selection || selection.levels.length <= 1) return null;
  return {
    selection,
    query: argumentPrefix.slice(separatorIndex + REASONING_EFFORT_SEPARATOR.length),
  };
}

function modelCatalogKey(groups: ModelProviderGroup[]): string {
  return JSON.stringify(groups.map(({ provider, models }) => [
    provider.id,
    provider.baseURL,
    provider.authType ?? "api",
    provider.protocol ?? "default",
    provider.apiKey,
    models.map((model) => [
      model.id,
      model.name,
      model.reasoningLevels,
      model.defaultReasoningLevel,
      model.contextWindow,
      model.useResponsesLite,
      model.toolOutputTokenLimit,
      model.tier,
    ]),
  ]));
}

export function buildModelAutocompleteItems(
  groups: ModelProviderGroup[],
  argumentPrefix = "",
  currentThinkingLevel: ThinkingLevel = "off",
): AutocompleteItem[] {
  const selections = selectableModels(groups);
  const effort = effortPhase(selections, argumentPrefix);
  if (effort) {
    const toggle = isThinkingToggleModel(effort.selection.provider.id, effort.selection.model.id);
    const query = effort.query.trim().toLowerCase();
    const baseValue = `${effort.selection.value}${REASONING_EFFORT_SEPARATOR}`;
    return effort.selection.levels.flatMap((level) => {
      const label = toggle ? (level === "off" ? "off" : "on") : level;
      const description = toggle
        ? (level === "off" ? "thinking disabled" : "thinking enabled")
        : EFFORT_DESCRIPTIONS[level];
      if (query && !`${label} ${level} ${description}`.toLowerCase().includes(query)) return [];
      return [{
        value: `${baseValue}${level}`,
        label,
        description,
        submitOnSelect: true,
      }];
    });
  }

  const query = argumentPrefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [];

  for (const selection of selections) {
    const { provider, model, value, levels } = selection;
    const label = model.name || model.id;
    const description = label === model.id
      ? provider.name
      : `${provider.name} · ${model.id}`;
    const searchable = `${value} ${label} ${description}`.toLowerCase();
    if (query && !searchable.includes(query)) continue;

    const level = preferredThinkingLevel(selection, currentThinkingLevel);
    items.push({
      value: levels.length > 1
        ? `${value}${REASONING_EFFORT_SEPARATOR}`
        : `${value}${REASONING_EFFORT_SEPARATOR}${level}`,
      label,
      description,
      submitOnSelect: levels.length <= 1,
    });
  }

  return items;
}

/**
 * Build the command surface in execution-priority order. The registry remains
 * live so MCP prompts that connect after startup appear on the next keypress.
 */
export function buildComposerSlashCommands(
  commands: UnifiedCommand[],
  skills: SkillSummary[],
  uiMode: TuiMode = "regular",
  modelCompletions?: ModelCompletionSource,
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
    if (command.name === "model" && modelCompletions) {
      add({
        name: command.name,
        description: command.description,
        argumentHint: "<model>",
        submitOnSelect: false,
        argumentInputHint: {
          prompt: "⌕ ",
          placeholder: "Search models…",
          valuePrefix: "/model ",
        },
        keepArgumentMenuOnEmpty: true,
        argumentEmptyMessage: "No matching models",
        getArgumentCompletions: modelCompletions,
      });
    } else {
      add({ name: command.name, description: command.description });
    }
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
  private discoveredModels: { key: string; groups: ModelProviderGroup[] } | null = null;
  private modelRefresh: { key: string; task: Promise<void> } | null = null;

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
        this.sources.registry ? (prefix) => this.getModelCompletions(prefix) : undefined,
      ),
      this.sources.cwd,
      this.sources.fdPath ?? null,
    );
  }

  private getModelCompletions(argumentPrefix: string): AutocompleteArgumentSuggestions | null {
    const registry = this.sources.registry;
    if (!registry) return null;

    const localGroups = getVisibleModelProviders(registry).map((provider) => ({
      provider,
      models: localModelsForProvider(registry, provider),
    }));
    const key = modelCatalogKey(localGroups);
    const groups = this.discoveredModels?.key === key ? this.discoveredModels.groups : localGroups;

    this.refreshModelCatalog(key);
    const currentThinkingLevel = this.sources.thinkingLevel?.() ?? "off";
    const items = buildModelAutocompleteItems(groups, argumentPrefix, currentThinkingLevel);
    const selections = selectableModels(groups);
    const effort = effortPhase(selections, argumentPrefix);
    if (!effort) {
      return {
        items,
        inputHint: {
          prompt: "⌕ ",
          placeholder: "Search models…",
          valuePrefix: MODEL_COMMAND_PREFIX,
        },
        keepOpenOnEmpty: true,
        emptyMessage: "No matching models",
      };
    }

    const toggle = isThinkingToggleModel(effort.selection.provider.id, effort.selection.model.id);
    const baseValue = `${effort.selection.value}${REASONING_EFFORT_SEPARATOR}`;
    const preferredLevel = preferredThinkingLevel(effort.selection, currentThinkingLevel);
    return {
      items,
      inputHint: {
        prompt: "◆ ",
        placeholder: toggle ? "Select thinking mode…" : "Select reasoning effort…",
        valuePrefix: `${MODEL_COMMAND_PREFIX}${baseValue}`,
        backValue: MODEL_COMMAND_PREFIX,
      },
      keepOpenOnEmpty: true,
      emptyMessage: toggle ? "No matching modes" : "No matching efforts",
      ...(effort.query.length === 0
        ? { preferredValue: `${baseValue}${preferredLevel}` }
        : {}),
    };
  }

  /**
   * Remote discovery enriches the already-visible local catalog. It is shared
   * per provider snapshot and runs all providers concurrently, so opening the
   * composer menu never waits on network latency.
   */
  private refreshModelCatalog(key: string): void {
    const registry = this.sources.registry;
    if (!registry || this.discoveredModels?.key === key || this.modelRefresh?.key === key) return;

    const task = discoverModelProviderGroups(registry).then((groups) => {
      const currentGroups = getVisibleModelProviders(registry).map((provider) => ({
        provider,
        models: localModelsForProvider(registry, provider),
      }));
      if (modelCatalogKey(currentGroups) !== key) return;
      this.discoveredModels = { key, groups };
      this.sources.onModelSuggestionsChanged?.();
    }).finally(() => {
      if (this.modelRefresh?.task === task) this.modelRefresh = null;
    });
    this.modelRefresh = { key, task };
  }
}

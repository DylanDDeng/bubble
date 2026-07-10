import React, { useState, useEffect, useMemo, useRef } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { isKeyReleaseEvent } from "./key-events.js";
import { useTheme } from "./theme.js";
import {
  ProviderRegistry,
  encodeModel,
  decodeModel,
  displayModel,
  isUserVisibleProvider,
  type ModelDiscoverySource,
  type ModelInfo,
  type ProviderProfile,
} from "../provider-registry.js";
import { listBuiltinModels } from "../model-catalog.js";
import { padVisual, truncateVisual } from "../text-display.js";
import { hasTerminalMouseSequence } from "./terminal-mouse.js";
import { getAvailableThinkingLevels, isThinkingOnlyLevels, isThinkingToggleModel, normalizeThinkingLevel } from "../provider-transform.js";
import type { ThinkingLevel } from "../types.js";

export { padVisual, truncateVisual } from "../text-display.js";

export interface ModelPickerOption {
  id: string;
  label: string;
  group: string;
  providerBadge: string;
  reasoningLevels: ThinkingLevel[];
  defaultReasoningLevel?: ThinkingLevel;
  contextWindow?: number;
  toolOutputTokenLimit?: number;
  available: boolean;
  pending: boolean;
}

export type ModelPickerPhase =
  | { kind: "model" }
  | { kind: "effort"; model: ModelPickerOption; selectedIndex: number };

export interface ModelProviderDiscoveryState {
  status: "pending" | "complete";
  models: ModelInfo[];
  source?: ModelDiscoverySource;
  authoritative: boolean;
  error?: string;
}

export type PickerKeyAction = "up" | "down" | "enter" | "escape" | "backspace" | "delete";

export function resolvePickerKeyAction(
  input: string,
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
  },
): PickerKeyAction | undefined {
  if (key.escape) return "escape";
  if (key.return) return "enter";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";

  const sequence = normalizeEscapeSequence(input);
  if (/^(?:O|\[[\d;:]*)A$/.test(sequence)) return "up";
  if (/^(?:O|\[[\d;:]*)B$/.test(sequence)) return "down";

  return undefined;
}

export function isPrintablePickerInput(input: string): boolean {
  if (!input) return false;
  if (hasTerminalMouseSequence(input)) return false;
  if (input.startsWith("\x1b")) return false;
  if (isRawEscapeTail(input)) return false;
  return !/[\x00-\x1f\x7f]/.test(input);
}

export function formatSkillPickerRow(
  skill: { name: string; description?: string },
  options: { selected: boolean; width: number },
): string {
  const width = Math.max(12, options.width);
  const marker = options.selected ? "> " : "  ";
  const nameBudget = Math.max(8, Math.min(28, Math.floor(width * 0.35)));
  const name = truncateVisual(skill.name, nameBudget);
  const nameCell = padVisual(name, nameBudget);
  const description = (skill.description ?? "").replace(/\s+/g, " ").trim();
  const row = description
    ? `${marker}${nameCell}  ${description}`
    : `${marker}${nameCell}`;
  return padVisual(truncateVisual(row, width), width);
}

export const MODEL_PICKER_MAX_BODY_ROWS = 10;
export const MODEL_PICKER_CHROME_ROWS = 14;
export const MODEL_PICKER_RECENT_FAMILY_LIMIT = 3;

export type ModelPickerDisplayItem =
  | { kind: "header"; key: string; label: string }
  | { kind: "model"; key: string; option: ModelPickerOption };

export function modelPickerBodyRows(termHeight: number): number {
  const rows = Number.isFinite(termHeight) ? Math.floor(termHeight) : 24;
  return Math.max(1, Math.min(MODEL_PICKER_MAX_BODY_ROWS, rows - MODEL_PICKER_CHROME_ROWS));
}

export function clampPickerIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

export function pickerWindowStart(selectedIndex: number, length: number, visibleRows: number): number {
  const rows = Math.max(1, Math.floor(visibleRows));
  const safeIndex = clampPickerIndex(selectedIndex, length);
  const maxStart = Math.max(0, length - rows);
  return Math.max(0, Math.min(maxStart, safeIndex - Math.floor(rows / 2)));
}

export function padPickerRows(rows: string[], bodyRows: number, width: number): string[] {
  const rowCount = Math.max(1, Math.floor(bodyRows));
  const rowWidth = Math.max(1, Math.floor(width));
  const padded = rows.slice(0, rowCount).map((row) => padVisual(truncateVisual(row, rowWidth), rowWidth));
  while (padded.length < rowCount) {
    padded.push(padVisual("", rowWidth));
  }
  return padded;
}

export function modelPickerRecentKey(recent: readonly string[]): string {
  return recent.join("\u0000");
}

/**
 * Returns a provider-scoped family key for model ordering.
 *
 * Keep this deliberately conservative: suffixes such as `mini`, `codex`,
 * `spark`, or `highspeed` often describe distinct products rather than
 * interchangeable siblings. The Codex Sol/Terra/Luna trio is the one family
 * whose relationship is explicitly declared by the provider catalog.
 */
export function modelPickerFamilyKey(
  provider: Pick<ProviderProfile, "id" | "authType">,
  modelId: string,
): string {
  const isCodexOAuth = provider.id === "openai-codex"
    || (provider.id === "openai" && provider.authType === "oauth");
  if (isCodexOAuth) {
    const match = /^(gpt-\d+(?:\.\d+)+)-(sol|terra|luna)$/i.exec(modelId);
    if (match) return `${provider.id}:${match[1].toLowerCase()}:sol-terra-luna`;
  }
  return `${provider.id}:${modelId}`;
}

export function buildModelPickerDisplayItems(
  options: readonly ModelPickerOption[],
): ModelPickerDisplayItem[] {
  const items: ModelPickerDisplayItem[] = [];
  let previousGroup: string | undefined;
  let headerIndex = 0;
  for (const option of options) {
    if (option.group !== previousGroup) {
      previousGroup = option.group;
      items.push({
        kind: "header",
        key: `header:${headerIndex++}:${option.group}`,
        label: option.group,
      });
    }
    items.push({ kind: "model", key: option.id, option });
  }
  return items;
}

export function resolveModelPickerDisplayIndex(
  items: readonly ModelPickerDisplayItem[],
  selectedId: string | undefined,
): number {
  if (selectedId) {
    const selectedIndex = items.findIndex(
      (item) => item.kind === "model" && item.option.id === selectedId,
    );
    if (selectedIndex >= 0) return selectedIndex;
  }
  const firstModelIndex = items.findIndex((item) => item.kind === "model");
  return firstModelIndex >= 0 ? firstModelIndex : 0;
}

export function filterAndRankModelPickerOptions(
  options: readonly ModelPickerOption[],
  query: string,
): ModelPickerOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...options];

  return options
    .map((option, index) => {
      const { modelId } = decodeModel(option.id);
      const fields = [option.label, modelId, option.id, option.providerBadge]
        .map((value) => value.toLowerCase());
      const rank = fields.some((value) => value === normalized)
        ? 0
        : fields.some((value) => value.startsWith(normalized))
          ? 1
          : fields.some((value) => value.includes(normalized))
            ? 2
            : Number.POSITIVE_INFINITY;
      return { option, index, rank };
    })
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.option);
}

function isThinkingToggleOption(option: Pick<ModelPickerOption, "id" | "providerBadge">): boolean {
  const decoded = decodeModel(option.id);
  return isThinkingToggleModel(decoded.providerId || option.providerBadge, decoded.modelId);
}

export function formatReasoningLevelsLabel(levels: readonly ThinkingLevel[], asToggle = false): string {
  if (levels.length === 0) return "checking";
  if (isThinkingOnlyLevels(levels)) return "on";
  if (asToggle) return "thinking on/off";
  return levels.join("/");
}

export function formatModelPickerRow(
  option: Pick<ModelPickerOption, "id" | "label" | "providerBadge" | "reasoningLevels">
    & Partial<Pick<ModelPickerOption, "available" | "pending">>,
  options: { selected: boolean; current: boolean; width: number },
): string {
  const width = Math.max(24, options.width);
  const marker = options.selected ? "> " : "  ";
  const label = option.label.replace(/\s+/g, " ").trim();
  const provider = option.providerBadge.replace(/\s+/g, " ").trim();
  const effort = option.pending
    ? "checking"
    : (option.available === false || option.reasoningLevels.length === 0)
      ? "unavailable"
      : formatReasoningLevelsLabel(option.reasoningLevels, isThinkingToggleOption(option));
  const current = options.current ? " ●" : "";
  const providerWidth = Math.max(6, Math.min(16, Math.floor(width * 0.18)));
  const effortWidth = Math.max(12, Math.min(30, Math.floor(width * 0.32)));
  const labelWidth = Math.max(6, width - marker.length - providerWidth - effortWidth - 4 - current.length);
  const row = [
    marker,
    padVisual(truncateVisual(label, labelWidth), labelWidth),
    "  ",
    padVisual(truncateVisual(provider, providerWidth), providerWidth),
    "  ",
    truncateVisual(effort, effortWidth),
    current,
  ].join("");
  return padVisual(truncateVisual(row, width), width);
}

export function formatEffortPickerRow(
  level: ThinkingLevel,
  options: { selected: boolean; width: number; asToggle?: boolean },
): string {
  const width = Math.max(24, options.width);
  const marker = options.selected ? "> " : "  ";
  const name = options.asToggle ? (level === "off" ? "off" : "on") : level;
  const row = `${marker}${name}  ${effortDescription(level, options.asToggle)}`;
  return padVisual(truncateVisual(row, width), width);
}

export function formatNoModelResultsRow(query: string, width: number): string {
  const rowWidth = Math.max(24, width);
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const row = normalizedQuery
    ? `  No models match "${normalizedQuery}"`
    : "  No models available";
  return padVisual(truncateVisual(row, rowWidth), rowWidth);
}

export function preferredEffortIndex(
  option: Pick<ModelPickerOption, "reasoningLevels" | "defaultReasoningLevel">,
  currentThinkingLevel: ThinkingLevel,
): number {
  const currentIndex = option.reasoningLevels.indexOf(currentThinkingLevel);
  if (currentIndex >= 0) return currentIndex;
  if (option.defaultReasoningLevel) {
    const defaultIndex = option.reasoningLevels.indexOf(option.defaultReasoningLevel);
    if (defaultIndex >= 0) return defaultIndex;
  }
  const preferred = normalizeThinkingLevel(currentThinkingLevel, option.reasoningLevels);
  const index = option.reasoningLevels.indexOf(preferred);
  return index >= 0 ? index : 0;
}

export function shouldOpenEffortPicker(option: Pick<ModelPickerOption, "reasoningLevels">): boolean {
  return option.reasoningLevels.length > 1;
}

export function isModelOptionSelectable(
  option: Pick<ModelPickerOption, "available" | "pending" | "reasoningLevels">,
): boolean {
  return option.available && !option.pending && option.reasoningLevels.length > 0;
}

export function resolveSelectedModelId(
  options: readonly ModelPickerOption[],
  selectedId: string | undefined,
): string | undefined {
  if (selectedId) {
    const selected = options.find((option) => option.id === selectedId);
    if (selected && isModelOptionSelectable(selected)) return selected.id;
  }
  return options.find(isModelOptionSelectable)?.id;
}

export function moveModelSelection(
  options: readonly ModelPickerOption[],
  selectedId: string | undefined,
  direction: -1 | 1,
): string | undefined {
  const selectableIndexes = options
    .map((option, index) => isModelOptionSelectable(option) ? index : -1)
    .filter((index) => index >= 0);
  if (selectableIndexes.length === 0) return undefined;
  const currentIndex = options.findIndex((option) => option.id === selectedId);
  if (currentIndex < 0) {
    return options[direction > 0 ? selectableIndexes[0] : selectableIndexes[selectableIndexes.length - 1]]?.id;
  }
  const target = direction > 0
    ? selectableIndexes.find((index) => index > currentIndex)
    : [...selectableIndexes].reverse().find((index) => index < currentIndex);
  return options[target ?? currentIndex]?.id ?? selectedId;
}

export function reconcileModelPickerPhase(
  phase: ModelPickerPhase,
  options: readonly ModelPickerOption[],
  currentThinkingLevel: ThinkingLevel,
): ModelPickerPhase {
  if (phase.kind !== "effort") return phase;
  const latest = options.find((option) => option.id === phase.model.id);
  if (!latest || !isModelOptionSelectable(latest)) return { kind: "model" };

  const selectedLevel = phase.model.reasoningLevels[phase.selectedIndex];
  const selectedIndex = selectedLevel && latest.reasoningLevels.includes(selectedLevel)
    ? latest.reasoningLevels.indexOf(selectedLevel)
    : preferredEffortIndex(latest, currentThinkingLevel);
  if (selectedIndex === phase.selectedIndex && sameModelOptionMetadata(phase.model, latest)) return phase;
  return { kind: "effort", model: latest, selectedIndex };
}

function effortDescription(level: ThinkingLevel, asToggle?: boolean): string {
  if (asToggle) return level === "off" ? "thinking disabled" : "thinking enabled";
  switch (level) {
    case "off":
      return "no reasoning effort";
    case "minimal":
      return "fastest reasoning";
    case "low":
      return "light reasoning";
    case "medium":
      return "balanced reasoning";
    case "high":
      return "deeper reasoning";
    case "xhigh":
      return "extra high reasoning";
    case "max":
      return "maximum provider effort";
    case "ultra":
      return "maximum effort with delegation";
    default:
      return "reasoning effort";
  }
}

function normalizeEscapeSequence(input: string): string {
  return input.startsWith("\x1b") ? input.slice(1) : input;
}

function isRawEscapeTail(input: string): boolean {
  return /^(?:O[ABCDHF]|\[[\d;:]*[A-Za-z~])$/.test(input);
}

export interface ModelPickerProps {
  registry: ProviderRegistry;
  current: string;
  currentThinkingLevel: ThinkingLevel;
  recent: string[];
  onSelect: (model: string, thinkingLevel: ThinkingLevel) => void;
  onCancel: () => void;
}

export function ModelPicker({ registry, current, currentThinkingLevel, recent, onSelect, onCancel }: ModelPickerProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const terminalColumns = stdout?.columns || 80;
  const bodyRows = modelPickerBodyRows(termHeight);
  const rowWidth = Math.max(36, Math.min(110, terminalColumns - 6));

  const recentKey = modelPickerRecentKey(recent);
  const enabledSnapshot = registry.getEnabled().filter((provider) => isUserVisibleProvider(provider.id));
  const providerKey = enabledSnapshot
    .map((provider) => [
      provider.id,
      provider.name,
      provider.baseURL,
      provider.authType ?? "",
      provider.protocol ?? "",
    ].join("\u0000"))
    .join("\u0001");
  const enabledProviders = useMemo(
    () => registry.getEnabled().filter((provider) => isUserVisibleProvider(provider.id)),
    [registry, providerKey],
  );
  const localModelsByProvider = useMemo(
    () => new Map(enabledProviders.map((provider) => [
      provider.id,
      localModelsForProvider(registry, provider),
    ])),
    [registry, providerKey],
  );
  const [discoveries, setDiscoveries] = useState<Map<string, ModelProviderDiscoveryState>>(() => new Map());
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const requestGenerationRef = useRef(0);
  const rawOptions = useMemo(() => buildMergedModelOptions({
    providers: enabledProviders,
    localModelsByProvider,
    discoveries,
    current,
    recent,
  }), [enabledProviders, localModelsByProvider, discoveries, current, recentKey]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    resolveSelectedModelId(buildLocalModelOptions(registry, current, recent), current)
  );
  const [phase, setPhase] = useState<ModelPickerPhase>({ kind: "model" });

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    setDiscoveries((previous) => {
      const next = new Map<string, ModelProviderDiscoveryState>();
      for (const provider of enabledProviders) {
        const prior = previous.get(provider.id);
        next.set(provider.id, {
          status: "pending",
          models: prior?.models ?? [],
          source: prior?.source,
          authoritative: prior?.authoritative ?? false,
        });
      }
      return next;
    });

    for (const provider of enabledProviders) {
      void discoverModelsForPicker(registry, provider, refreshGeneration > 0)
        .then((result) => {
          if (requestGenerationRef.current !== generation) return;
          setDiscoveries((previous) => {
            const next = new Map(previous);
            next.set(provider.id, { status: "complete", ...result });
            return next;
          });
        })
        .catch((error) => {
          if (requestGenerationRef.current !== generation) return;
          setDiscoveries((previous) => {
            const next = new Map(previous);
            next.set(provider.id, {
              status: "complete",
              models: localModelsByProvider.get(provider.id) ?? [],
              source: "fallback",
              authoritative: false,
              error: error instanceof Error ? error.message : String(error),
            });
            return next;
          });
        });
    }

    return () => {
      if (requestGenerationRef.current === generation) requestGenerationRef.current++;
    };
  }, [registry, providerKey, refreshGeneration]);

  const options = useMemo(() => {
    return filterAndRankModelPickerOptions(rawOptions, query);
  }, [rawOptions, query]);

  const resolvedSelectedId = resolveSelectedModelId(options, selectedId);
  const selectedIndex = resolvedSelectedId
    ? options.findIndex((option) => option.id === resolvedSelectedId)
    : -1;

  useEffect(() => {
    if (selectedId !== resolvedSelectedId) setSelectedId(resolvedSelectedId);
  }, [selectedId, resolvedSelectedId]);

  useEffect(() => {
    setPhase((currentPhase) => reconcileModelPickerPhase(currentPhase, rawOptions, currentThinkingLevel));
  }, [rawOptions, currentThinkingLevel]);

  const discoveryStatus = formatModelDiscoveryStatus(enabledProviders, discoveries);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    const action = resolvePickerKeyAction(input, key);
    if (phase.kind === "effort") {
      const levels = phase.model.reasoningLevels;
      if (action === "escape" || action === "backspace" || action === "delete") {
        setPhase({ kind: "model" });
        return;
      }
      if (action === "enter") {
        const level = levels[clampPickerIndex(phase.selectedIndex, levels.length)];
        if (level) onSelect(phase.model.id, level);
        return;
      }
      if (action === "up") {
        setPhase((currentPhase) => currentPhase.kind === "effort"
          ? { ...currentPhase, selectedIndex: clampPickerIndex(currentPhase.selectedIndex - 1, levels.length) }
          : currentPhase);
        return;
      }
      if (action === "down") {
        setPhase((currentPhase) => currentPhase.kind === "effort"
          ? { ...currentPhase, selectedIndex: clampPickerIndex(currentPhase.selectedIndex + 1, levels.length) }
          : currentPhase);
        return;
      }
      return;
    }

    if (key.ctrl && (input.toLowerCase() === "r" || input === "\x12")) {
      setRefreshGeneration((generation) => generation + 1);
      return;
    }
    if (action === "escape") {
      onCancel();
      return;
    }
    if (action === "enter") {
      const opt = selectedIndex >= 0 ? options[selectedIndex] : undefined;
      if (opt && isModelOptionSelectable(opt)) {
        if (shouldOpenEffortPicker(opt)) {
          setPhase({
            kind: "effort",
            model: opt,
            selectedIndex: preferredEffortIndex(opt, currentThinkingLevel),
          });
        } else {
          const level = opt.reasoningLevels[0];
          if (level) onSelect(opt.id, level);
        }
      }
      return;
    }
    if (action === "up") {
      setSelectedId((id) => moveModelSelection(options, id, -1));
      return;
    }
    if (action === "down") {
      setSelectedId((id) => moveModelSelection(options, id, 1));
      return;
    }
    if (action === "backspace" || action === "delete") {
      setQuery((q) => {
        const next = q.slice(0, -1);
        setSelectedId(undefined);
        return next;
      });
      return;
    }
    if (isPrintablePickerInput(input) && !key.ctrl && !key.meta) {
      setQuery((q) => {
        const next = q + input;
        setSelectedId(undefined);
        return next;
      });
      return;
    }
  });

  const displayItems = buildModelPickerDisplayItems(options);
  const safeSelectedDisplayIndex = resolveModelPickerDisplayIndex(displayItems, resolvedSelectedId);
  const start = pickerWindowStart(safeSelectedDisplayIndex, displayItems.length, bodyRows);
  const visible = displayItems.slice(start, start + bodyRows);
  const rawModelRows = options.length === 0
    ? [{
        key: "no-results",
        row: formatNoModelResultsRow(query, rowWidth),
        selected: false,
        header: false,
      }]
    : visible.map((item) => {
        if (item.kind === "header") {
          return {
            key: item.key,
            row: padVisual(truncateVisual(`  ${item.label}`, rowWidth), rowWidth),
            selected: false,
            header: true,
          };
        }
        const isSelected = item.option.id === resolvedSelectedId;
        return {
          key: item.key,
          row: formatModelPickerRow(item.option, {
            selected: isSelected,
            current: item.option.id === current,
            width: rowWidth,
          }),
          selected: isSelected,
          header: false,
        };
      });
  const modelRows = padPickerRows(rawModelRows.map((row) => row.row), bodyRows, rowWidth).map((row, index) => ({
    key: rawModelRows[index]?.key ?? `blank-${index}`,
    row,
    selected: rawModelRows[index]?.selected ?? false,
    header: rawModelRows[index]?.header ?? false,
  }));
  const highlightedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const enterAction = highlightedOption
    ? (shouldOpenEffortPicker(highlightedOption)
      ? (isThinkingToggleOption(highlightedOption) ? "choose mode" : "choose effort")
      : "select")
    : "wait";
  const effortTitle = phase.kind === "effort" && isThinkingToggleOption(phase.model)
    ? "Select Thinking Mode"
    : "Select Reasoning Effort";

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>{phase.kind === "effort" ? effortTitle : "Select Model"}</Text>
      {phase.kind === "effort" ? (
        <EffortPickerView
          model={phase.model}
          selectedIndex={phase.selectedIndex}
          bodyRows={bodyRows}
          rowWidth={rowWidth}
        />
      ) : (
        <>
          <SearchField query={query} placeholder="Type to search models..." width={rowWidth} />
          <Text color={theme.muted}>↑/↓ navigate · Enter {enterAction} · Esc cancel · Ctrl+R retry</Text>
          <Box height={1} overflow="hidden">
            <Text color={discoveryStatus.hasError ? theme.warning : theme.muted}>
              {discoveryStatus.text || " "}
            </Text>
          </Box>
        </>
      )}
      {phase.kind === "model" && <Box flexDirection="column" height={bodyRows} overflow="hidden" marginTop={1}>
        {modelRows.map(({ key, row, selected, header }) => (
          <Box key={key} height={1} overflow="hidden">
            <Text
              color={selected ? theme.accent : (header || key === "no-results" ? theme.muted : undefined)}
              bold={selected || header}
            >
              {row}
            </Text>
          </Box>
        ))}
      </Box>}
    </Box>
  );
}

function EffortPickerView({
  model,
  selectedIndex,
  bodyRows,
  rowWidth,
}: {
  model: ModelPickerOption;
  selectedIndex: number;
  bodyRows: number;
  rowWidth: number;
}) {
  const theme = useTheme();
  const safeSelectedIndex = clampPickerIndex(selectedIndex, model.reasoningLevels.length);
  const rawRows = model.reasoningLevels.map((level, index) => ({
    key: level,
    row: formatEffortPickerRow(level, {
      selected: index === safeSelectedIndex,
      width: rowWidth,
      asToggle: isThinkingToggleOption(model),
    }),
    selected: index === safeSelectedIndex,
  }));
  const effortRows = padPickerRows(rawRows.map((row) => row.row), bodyRows, rowWidth).map((row, index) => ({
    key: rawRows[index]?.key ?? `blank-${index}`,
    row,
    selected: rawRows[index]?.selected ?? false,
  }));
  const modelDetail = padVisual(
    truncateVisual(`${model.label} · ${model.providerBadge}`, rowWidth),
    rowWidth,
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box height={1} overflow="hidden">
        <Text color={theme.muted}>{modelDetail}</Text>
      </Box>
      <Text color={theme.muted}>↑/↓ navigate · Enter select · Esc back</Text>
      <Box flexDirection="column" height={bodyRows} overflow="hidden" marginTop={1}>
        {effortRows.map(({ key, row, selected }) => (
          <Box key={key} height={1} overflow="hidden">
            <Text color={selected ? theme.accent : undefined} bold={selected}>
              {row}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function SearchField({ query, placeholder, width }: { query: string; placeholder: string; width?: number }) {
  const theme = useTheme();
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setCursorVisible((v) => !v), 500);
    return () => clearInterval(t);
  }, []);
  const contentBudget = width ? Math.max(1, width - 3) : undefined;
  const visibleQuery = contentBudget ? truncateVisual(query, contentBudget) : query;
  const visiblePlaceholder = !query
    ? (contentBudget ? truncateVisual(` ${placeholder}`, contentBudget) : ` ${placeholder}`)
    : "";
  return (
    <Box height={1} overflow="hidden" marginTop={1}>
      <Text color={theme.accent}>{"❯ "}</Text>
      <Text>{visibleQuery}</Text>
      <Text color={theme.accent} inverse={cursorVisible}> </Text>
      {visiblePlaceholder && <Text color={theme.muted} dimColor>{visiblePlaceholder}</Text>}
    </Box>
  );
}

export function buildLocalModelOptions(
  registry: ProviderRegistry,
  current: string,
  recent: string[],
): ModelPickerOption[] {
  const providers = registry.getEnabled().filter((provider) => isUserVisibleProvider(provider.id));
  const localModelsByProvider = new Map(providers.map((provider) => [
    provider.id,
    localModelsForProvider(registry, provider),
  ]));
  return buildMergedModelOptions({
    providers,
    localModelsByProvider,
    discoveries: new Map(),
    current,
    recent,
  });
}

export function buildMergedModelOptions(input: {
  providers: ReturnType<ProviderRegistry["getEnabled"]>;
  localModelsByProvider: ReadonlyMap<string, readonly ModelInfo[]>;
  discoveries: ReadonlyMap<string, ModelProviderDiscoveryState>;
  current: string;
  recent: readonly string[];
}): ModelPickerOption[] {
  const opts: ModelPickerOption[] = [];
  const seen = new Set<string>();
  const providerById = new Map(input.providers.map((provider) => [provider.id, provider]));
  const effectiveModelsByProvider = new Map(input.providers.map((provider) => {
    const localModels = input.localModelsByProvider.get(provider.id) ?? [];
    const discovery = input.discoveries.get(provider.id);
    return [provider.id, effectiveProviderModels(localModels, discovery)] as const;
  }));
  const promotedFamilies = new Set<string>();
  const promotedRecentProviderIds: string[] = [];

  const familyKeyForId = (id: string): string => {
    const { providerId, modelId } = decodeModel(id);
    const provider = providerId ? providerById.get(providerId) : undefined;
    return provider
      ? modelPickerFamilyKey(provider, modelId)
      : `unknown:${id}`;
  };

  const appendPinned = (id: string, group: "Current" | "Recent") => {
    appendModelOption(opts, seen, pinnedModelOption({
      id,
      group,
      providers: input.providers,
      localModelsByProvider: input.localModelsByProvider,
      discoveries: input.discoveries,
    }));
  };

  const appendFamily = (seedId: string, group: "Current" | "Recent") => {
    const { providerId, modelId } = decodeModel(seedId);
    const provider = providerId ? providerById.get(providerId) : undefined;
    if (!provider) {
      appendPinned(seedId, group);
      return;
    }

    const familyKey = modelPickerFamilyKey(provider, modelId);
    const familyModels = (effectiveModelsByProvider.get(provider.id) ?? [])
      .filter((model) => modelPickerFamilyKey(provider, model.id) === familyKey);
    for (const model of familyModels) {
      appendModelOption(opts, seen, {
        ...modelOptionMetadata(encodeModel(provider.id, model.id), model, true),
        group,
        providerBadge: provider.name,
        available: true,
        pending: false,
      });
    }
    // Keep an exact Current/Recent pin visible even when an authoritative
    // catalog no longer contains it. It remains unavailable and never causes
    // local siblings to be reintroduced.
    if (!familyModels.some((model) => model.id === modelId)) appendPinned(seedId, group);
  };

  if (input.current) {
    appendPinned(input.current, "Current");
    const currentFamilyKey = familyKeyForId(input.current);
    promotedFamilies.add(currentFamilyKey);
    appendFamily(input.current, "Current");
  }

  let recentFamilyCount = 0;
  for (const recentId of [...new Set(input.recent)]) {
    if (!recentId || recentId === input.current) continue;
    const familyKey = familyKeyForId(recentId);
    if (promotedFamilies.has(familyKey)) {
      // A previously promoted family may not contain this exact Recent model
      // in an authoritative catalog. Preserve that pin as unavailable; when
      // it is present, exact-ID deduplication makes this a no-op.
      appendPinned(recentId, "Recent");
      continue;
    }
    promotedFamilies.add(familyKey);
    recentFamilyCount += 1;
    const { providerId } = decodeModel(recentId);
    if (providerId && providerById.has(providerId) && !promotedRecentProviderIds.includes(providerId)) {
      promotedRecentProviderIds.push(providerId);
    }
    appendFamily(recentId, "Recent");
    if (recentFamilyCount >= MODEL_PICKER_RECENT_FAMILY_LIMIT) break;
  }

  const orderedProviderIds: string[] = [];
  const addProviderId = (providerId: string | undefined) => {
    if (providerId && providerById.has(providerId) && !orderedProviderIds.includes(providerId)) {
      orderedProviderIds.push(providerId);
    }
  };
  addProviderId(decodeModel(input.current).providerId);
  for (const providerId of promotedRecentProviderIds) addProviderId(providerId);
  for (const provider of input.providers) addProviderId(provider.id);

  for (const providerId of orderedProviderIds) {
    const provider = providerById.get(providerId);
    if (!provider) continue;
    for (const model of effectiveModelsByProvider.get(provider.id) ?? []) {
      appendModelOption(opts, seen, {
        ...modelOptionMetadata(encodeModel(provider.id, model.id), model, true),
        group: provider.name,
        providerBadge: provider.name,
        available: true,
        pending: false,
      });
    }
  }

  return opts;
}

function localModelsForProvider(registry: ProviderRegistry, provider: ReturnType<ProviderRegistry["getEnabled"]>[number]): ModelInfo[] {
  const customModels = registry.getModelConfig().getCustomModels(provider.id);
  if (customModels.length > 0) return customModels;
  const builtinProviderId = provider.id === "openai" && provider.authType === "oauth"
    ? "openai-codex"
    : provider.id;
  return listBuiltinModels(builtinProviderId).map((model) => ({
    id: model.id,
    name: model.name,
    providerId: provider.id,
    reasoningLevels: model.reasoningLevels,
    defaultReasoningLevel: model.defaultReasoningLevel,
    contextWindow: model.contextWindow,
    toolOutputTokenLimit: model.toolOutputTokenLimit,
  }));
}

function appendModelOption(
  options: ModelPickerOption[],
  seen: Set<string>,
  option: ModelPickerOption,
): void {
  if (seen.has(option.id)) return;
  seen.add(option.id);
  options.push(option);
}

function pinnedModelOption(input: {
  id: string;
  group: "Recent" | "Current";
  providers: ReturnType<ProviderRegistry["getEnabled"]>;
  localModelsByProvider: ReadonlyMap<string, readonly ModelInfo[]>;
  discoveries: ReadonlyMap<string, ModelProviderDiscoveryState>;
}): ModelPickerOption {
  const { providerId, modelId } = decodeModel(input.id);
  const provider = input.providers.find((item) => item.id === providerId);
  if (!provider) {
    return {
      ...modelOptionMetadata(input.id, undefined, false),
      group: input.group,
      providerBadge: providerId || "",
      available: false,
      pending: false,
    };
  }

  const local = input.localModelsByProvider.get(provider.id) ?? [];
  const discovery = input.discoveries.get(provider.id);
  const discoveredModel = discovery?.models.find((model) => model.id === modelId);
  const localModel = local.find((model) => model.id === modelId);
  const metadata = discoveredModel ?? localModel;
  const hasKnownMetadata = !!metadata;

  let available = hasKnownMetadata;
  let pending = false;
  if (!discovery || discovery.status === "pending") {
    pending = !hasKnownMetadata;
  } else if (discovery.authoritative) {
    available = !!discoveredModel;
  }

  return {
    ...modelOptionMetadata(input.id, metadata, hasKnownMetadata),
    group: input.group,
    providerBadge: provider.name,
    available,
    pending,
  };
}

function effectiveProviderModels(
  localModels: readonly ModelInfo[],
  discovery: ModelProviderDiscoveryState | undefined,
): readonly ModelInfo[] {
  if (!discovery) return localModels;
  if (discovery.authoritative) return discovery.models;
  return discovery.models.length > 0 ? discovery.models : localModels;
}

function modelOptionMetadata(
  id: string,
  rawModel: ModelInfo | undefined,
  known: boolean,
): Pick<
  ModelPickerOption,
  "id" | "label" | "reasoningLevels" | "defaultReasoningLevel" | "contextWindow" | "toolOutputTokenLimit"
> {
  const model = rawModel;
  const reasoningLevels = model?.reasoningLevels
    ? [...model.reasoningLevels]
    : (known ? reasoningLevelsForModel(id) : []);
  const defaultReasoningLevel = model?.defaultReasoningLevel
    && reasoningLevels.includes(model.defaultReasoningLevel)
    ? model.defaultReasoningLevel
    : undefined;
  return {
    id,
    label: model?.name || displayModel(id),
    reasoningLevels,
    defaultReasoningLevel,
    contextWindow: model?.contextWindow,
    toolOutputTokenLimit: model?.toolOutputTokenLimit,
  };
}

async function discoverModelsForPicker(
  registry: ProviderRegistry,
  provider: ReturnType<ProviderRegistry["getEnabled"]>[number],
  forceRefresh: boolean,
): Promise<Omit<ModelProviderDiscoveryState, "status">> {
  return registry.discoverModels(provider, { forceRefresh });
}

export function formatModelDiscoveryStatus(
  providers: readonly Pick<ReturnType<ProviderRegistry["getEnabled"]>[number], "id" | "name">[],
  discoveries: ReadonlyMap<string, ModelProviderDiscoveryState>,
): { text: string; hasError: boolean } {
  if (providers.some((provider) => discoveries.get(provider.id)?.status !== "complete")) {
    return { text: "Refreshing model catalog…", hasError: false };
  }
  const failed = providers.filter((provider) => discoveries.get(provider.id)?.error);
  if (failed.length > 0) {
    const names = failed.slice(0, 2).map((provider) => provider.name).join(", ");
    const suffix = failed.length > 2 ? ` +${failed.length - 2}` : "";
    return { text: `Showing fallback models for ${names}${suffix} · Ctrl+R retry`, hasError: true };
  }
  return { text: "", hasError: false };
}

function sameModelOptionMetadata(left: ModelPickerOption, right: ModelPickerOption): boolean {
  return left.id === right.id
    && left.label === right.label
    && left.group === right.group
    && left.providerBadge === right.providerBadge
    && left.defaultReasoningLevel === right.defaultReasoningLevel
    && left.contextWindow === right.contextWindow
    && left.toolOutputTokenLimit === right.toolOutputTokenLimit
    && left.available === right.available
    && left.pending === right.pending
    && left.reasoningLevels.length === right.reasoningLevels.length
    && left.reasoningLevels.every((level, index) => level === right.reasoningLevels[index]);
}

function reasoningLevelsForModel(model: string): ThinkingLevel[] {
  const { providerId, modelId } = decodeModel(model);
  return getAvailableThinkingLevels(providerId || "openai", modelId);
}

export interface ProviderPickerProps {
  providers: Array<{ id: string; name: string; enabled: boolean }>;
  current?: string;
  onSelect: (providerId: string) => void;
  onCancel: () => void;
  title?: string;
  /** Fires whenever the highlighted row changes (and once on mount) — lets callers live-preview the selection. */
  onHighlight?: (providerId: string) => void;
}

export function ProviderPicker({ providers, current, onSelect, onCancel, title, onHighlight }: ProviderPickerProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const maxVisible = Math.max(5, termHeight - 8);

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = providers.findIndex((p) => p.id === current);
    return idx >= 0 ? idx : 0;
  });

  useEffect(() => {
    const p = providers[selectedIndex];
    if (p) onHighlight?.(p.id);
  }, [selectedIndex]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    const action = resolvePickerKeyAction(input, key);
    if (action === "escape") {
      onCancel();
      return;
    }
    if (action === "enter") {
      const p = providers[selectedIndex];
      if (p) onSelect(p.id);
      return;
    }
    if (action === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (action === "down") {
      setSelectedIndex((i) => Math.min(providers.length - 1, i + 1));
      return;
    }
    if (isPrintablePickerInput(input) && input.length === 1 && /[a-z]/i.test(input)) {
      const char = input.toLowerCase();
      for (let i = selectedIndex + 1; i < providers.length; i++) {
        if (providers[i].name.toLowerCase().startsWith(char)) {
          setSelectedIndex(i);
          return;
        }
      }
      for (let i = 0; i <= selectedIndex; i++) {
        if (providers[i].name.toLowerCase().startsWith(char)) {
          setSelectedIndex(i);
          return;
        }
      }
    }
  });

  const start = Math.max(0, Math.min(selectedIndex, providers.length - maxVisible));
  const visible = providers.slice(start, start + maxVisible);

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>{title || "Select Provider"}</Text>
      <Text color={theme.muted}>↑/↓ navigate · Enter select · Esc cancel · type letter to jump</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((p, i) => {
          const actualIndex = start + i;
          const isSelected = actualIndex === selectedIndex;
          return (
            <Box key={p.id}>
              <Text color={isSelected ? theme.accent : undefined}>
                {isSelected ? "> " : "  "}
                {p.name}
                {p.id === current ? " (current)" : ""}
                {!p.enabled ? " [disabled]" : ""}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export interface KeyPickerProps {
  providerName: string;
  onSubmit: (key: string) => void;
  onCancel: () => void;
}

export function KeyPicker({ providerName, onSubmit, onCancel }: KeyPickerProps) {
  const theme = useTheme();
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    const action = resolvePickerKeyAction(input, key);
    if (action === "escape") {
      onCancel();
      return;
    }
    if (action === "enter") {
      if (value.trim()) onSubmit(value.trim());
      return;
    }
    if (action === "backspace" || action === "delete") {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (isPrintablePickerInput(input) && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  // Append pasted clipboard content directly into the key field. Without
  // this the paste falls through to whichever other hook (InputBox's
  // usePaste) is active, and the key ends up in the main input area.
  usePaste((pasted) => {
    const clean = pasted.replace(/[\r\n\t]/g, "").trim();
    if (clean) setValue((v) => v + clean);
  });

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Enter API Key for {providerName}</Text>
      <Text color={theme.muted}>Paste or type the key · Enter to submit · Esc to cancel</Text>
      <SearchField query={value.replace(/./g, "*")} placeholder="Paste your key here..." />
    </Box>
  );
}

export interface SkillPickerProps {
  skills: Array<{ name: string; description: string }>;
  onSelect: (name: string) => void;
  onCancel: () => void;
}

export function SkillPicker({ skills, onSelect, onCancel }: SkillPickerProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const terminalColumns = stdout?.columns || 80;
  const maxVisible = Math.max(5, termHeight - 8);
  const rowWidth = Math.max(36, Math.min(96, terminalColumns - 6));
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((skill) =>
      skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q)
    );
  }, [query, skills]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    const action = resolvePickerKeyAction(input, key);
    if (action === "escape") {
      onCancel();
      return;
    }
    if (action === "enter") {
      const skill = options[selectedIndex];
      if (skill) onSelect(skill.name);
      return;
    }
    if (action === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (action === "down") {
      setSelectedIndex((i) => Math.min(Math.max(0, options.length - 1), i + 1));
      return;
    }
    if (action === "backspace" || action === "delete") {
      setQuery((q) => {
        const next = q.slice(0, -1);
        setSelectedIndex(0);
        return next;
      });
      return;
    }
    if (isPrintablePickerInput(input) && !key.ctrl && !key.meta) {
      setQuery((q) => {
        const next = q + input;
        setSelectedIndex(0);
        return next;
      });
    }
  });

  const maxStart = Math.max(0, options.length - maxVisible);
  const start = Math.max(0, Math.min(maxStart, selectedIndex - Math.floor(maxVisible / 2)));
  const visible = options.slice(start, start + maxVisible);

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Select Skill</Text>
      <SearchField query={query} placeholder="Type to search skills..." />
      <Text color={theme.muted}>↑/↓ navigate · Enter load · Esc cancel · Backspace clear</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.length === 0 && (
          <Text color={theme.muted}>No skills match "{query}"</Text>
        )}
        {visible.map((skill, i) => {
          const actualIndex = start + i;
          const isSelected = actualIndex === selectedIndex;
          const row = formatSkillPickerRow(skill, { selected: isSelected, width: rowWidth });
          return (
            <Box key={skill.name}>
              <Text inverse={isSelected} color={isSelected ? theme.accent : undefined} bold={isSelected}>
                {row}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

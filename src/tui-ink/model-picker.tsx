import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { isKeyReleaseEvent } from "./key-events.js";
import { useTheme } from "./theme.js";
import { ProviderRegistry, encodeModel, decodeModel, displayModel, isUserVisibleProvider, type ModelInfo } from "../provider-registry.js";
import { listBuiltinModels } from "../model-catalog.js";
import { padVisual, truncateVisual } from "../text-display.js";
import { hasTerminalMouseSequence } from "./terminal-mouse.js";
import { getAvailableThinkingLevels, normalizeThinkingLevel } from "../provider-transform.js";
import type { ThinkingLevel } from "../types.js";

export { padVisual, truncateVisual } from "../text-display.js";

export interface ModelPickerOption {
  id: string;
  label: string;
  group: string;
  providerBadge: string;
  reasoningLevels: ThinkingLevel[];
}

type ModelPickerPhase =
  | { kind: "model" }
  | { kind: "effort"; model: ModelPickerOption; selectedIndex: number };

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
export const MODEL_PICKER_CHROME_ROWS = 13;

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

// MiniMax models expose thinking as a binary on/off switch (the API's `thinking`
// param is disabled|adaptive — there's no graded effort), so render the "on"
// level as on/off instead of our internal "medium". Scoped to MiniMax only —
// other 2-level models (e.g. GLM toggles) keep their effort labels.
function isMiniMaxToggleModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("minimax");
}

export function formatReasoningLevelsLabel(levels: readonly ThinkingLevel[], asToggle = false): string {
  const normalized = levels.length > 0 ? levels : ["off"];
  if (asToggle) return "thinking on/off";
  return normalized.join("/");
}

export function formatModelPickerRow(
  option: Pick<ModelPickerOption, "id" | "label" | "providerBadge" | "reasoningLevels">,
  options: { selected: boolean; current: boolean; width: number },
): string {
  const width = Math.max(24, options.width);
  const marker = options.selected ? "> " : "  ";
  const label = option.label.replace(/\s+/g, " ").trim();
  const provider = option.providerBadge.replace(/\s+/g, " ").trim();
  const effort = formatReasoningLevelsLabel(option.reasoningLevels, isMiniMaxToggleModel(option.id));
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
  option: Pick<ModelPickerOption, "reasoningLevels">,
  currentThinkingLevel: ThinkingLevel,
): number {
  const preferred = normalizeThinkingLevel(currentThinkingLevel, option.reasoningLevels);
  const index = option.reasoningLevels.indexOf(preferred);
  return index >= 0 ? index : 0;
}

export function shouldOpenEffortPicker(option: Pick<ModelPickerOption, "reasoningLevels">): boolean {
  return option.reasoningLevels.length > 1;
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

  const [rawOptions, setRawOptions] = useState<ModelPickerOption[]>(() =>
    buildLocalModelOptions(registry, current, recent)
  );
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(() =>
    preferredModelIndex(buildLocalModelOptions(registry, current, recent), current)
  );
  const [phase, setPhase] = useState<ModelPickerPhase>({ kind: "model" });

  useEffect(() => {
    let cancelled = false;
    const localOptions = buildLocalModelOptions(registry, current, recent);
    setRawOptions(localOptions);
    setSelectedIndex(preferredModelIndex(localOptions, current));

    async function refreshRemote() {
      const enabled = registry.getEnabled();
      const opts: ModelPickerOption[] = [];
      const seen = new Set<string>();

      // Recent first
      for (const m of recent.slice(0, 5)) {
        const { providerId } = decodeModel(m);
        const provider = enabled.find((p) => p.id === providerId);
        appendModelOption(opts, seen, {
          id: m,
          label: displayModel(m),
          group: "Recent",
          providerBadge: provider?.name || providerId || "",
        });
      }

      const visibleProviders = enabled.filter((item) => isUserVisibleProvider(item.id));
      const discovered = await Promise.all(visibleProviders.map(async (provider) => {
        try {
          return { provider, models: await registry.listModels(provider) };
        } catch {
          return { provider, models: localModelsForProvider(registry, provider) };
        }
      }));

      for (const { provider, models } of discovered) {
        for (const m of models) {
          appendModelOption(opts, seen, {
            id: encodeModel(m.providerId, m.id),
            label: m.name,
            group: provider.name,
            providerBadge: provider.name,
          });
        }
      }

      if (current && !seen.has(current)) {
        const { providerId } = decodeModel(current);
        const provider = enabled.find((p) => p.id === providerId);
        opts.unshift({
          id: current,
          label: displayModel(current),
          group: "Current",
          providerBadge: provider?.name || providerId || "",
          reasoningLevels: reasoningLevelsForModel(current),
        });
      }

      if (!cancelled) {
        setRawOptions(opts);
        setSelectedIndex((index) => {
          const currentIndex = preferredModelIndex(opts, current);
          return index === preferredModelIndex(localOptions, current)
            ? currentIndex
            : clampPickerIndex(index, opts.length);
        });
      }
    }
    void refreshRemote();
    return () => {
      cancelled = true;
    };
  }, [registry, current, recent]);

  const options = useMemo(() => {
    if (!query.trim()) return rawOptions;
    const q = query.toLowerCase();
    return rawOptions.filter((opt) =>
      opt.label.toLowerCase().includes(q) || opt.providerBadge.toLowerCase().includes(q)
    );
  }, [rawOptions, query]);

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
        onSelect(phase.model.id, levels[clampPickerIndex(phase.selectedIndex, levels.length)] ?? "off");
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

    if (action === "escape") {
      onCancel();
      return;
    }
    if (action === "enter") {
      const opt = options[clampPickerIndex(selectedIndex, options.length)];
      if (opt) {
        if (shouldOpenEffortPicker(opt)) {
          setPhase({
            kind: "effort",
            model: opt,
            selectedIndex: preferredEffortIndex(opt, currentThinkingLevel),
          });
        } else {
          onSelect(opt.id, opt.reasoningLevels[0] ?? "off");
        }
      }
      return;
    }
    if (action === "up") {
      setSelectedIndex((i) => clampPickerIndex(i - 1, options.length));
      return;
    }
    if (action === "down") {
      setSelectedIndex((i) => clampPickerIndex(i + 1, options.length));
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
      return;
    }
  });

  const safeSelectedIndex = clampPickerIndex(selectedIndex, options.length);
  const start = pickerWindowStart(safeSelectedIndex, options.length, bodyRows);
  const visible = options.slice(start, start + bodyRows);
  const rawModelRows = options.length === 0
    ? [{
        key: "no-results",
        row: formatNoModelResultsRow(query, rowWidth),
        selected: false,
      }]
    : visible.map((opt, i) => {
        const actualIndex = start + i;
        const isSelected = actualIndex === safeSelectedIndex;
        return {
          key: opt.id,
          row: formatModelPickerRow(opt, {
            selected: isSelected,
            current: opt.id === current,
            width: rowWidth,
          }),
          selected: isSelected,
        };
      });
  const modelRows = padPickerRows(rawModelRows.map((row) => row.row), bodyRows, rowWidth).map((row, index) => ({
    key: rawModelRows[index]?.key ?? `blank-${index}`,
    row,
    selected: rawModelRows[index]?.selected ?? false,
  }));

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>{phase.kind === "effort" ? "Select Reasoning Effort" : "Select Model"}</Text>
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
          <Text color={theme.muted}>↑/↓ navigate · Enter choose effort · Esc cancel · Backspace clear</Text>
        </>
      )}
      {phase.kind === "model" && <Box flexDirection="column" height={bodyRows} overflow="hidden" marginTop={1}>
        {modelRows.map(({ key, row, selected }) => (
          <Box key={key} height={1} overflow="hidden">
            <Text color={selected ? theme.accent : (key === "no-results" ? theme.muted : undefined)} bold={selected}>
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
      asToggle: isMiniMaxToggleModel(model.id),
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
  const enabled = registry.getEnabled();
  const opts: ModelPickerOption[] = [];
  const seen = new Set<string>();

  for (const model of recent.slice(0, 5)) {
    const { providerId } = decodeModel(model);
    const provider = enabled.find((item) => item.id === providerId);
    appendModelOption(opts, seen, {
      id: model,
      label: displayModel(model),
      group: "Recent",
      providerBadge: provider?.name || providerId || "",
    });
  }

  for (const provider of enabled.filter((item) => isUserVisibleProvider(item.id))) {
    for (const model of localModelsForProvider(registry, provider)) {
      appendModelOption(opts, seen, {
        id: encodeModel(model.providerId, model.id),
        label: model.name,
        group: provider.name,
        providerBadge: provider.name,
      });
    }
  }

  if (current && !seen.has(current)) {
    const { providerId } = decodeModel(current);
    const provider = enabled.find((item) => item.id === providerId);
    opts.unshift({
      id: current,
      label: displayModel(current),
      group: "Current",
      providerBadge: provider?.name || providerId || "",
      reasoningLevels: reasoningLevelsForModel(current),
    });
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
  }));
}

function appendModelOption(
  options: ModelPickerOption[],
  seen: Set<string>,
  option: Omit<ModelPickerOption, "reasoningLevels"> & { reasoningLevels?: ThinkingLevel[] },
): void {
  if (seen.has(option.id)) return;
  seen.add(option.id);
  options.push({
    ...option,
    reasoningLevels: option.reasoningLevels ?? reasoningLevelsForModel(option.id),
  });
}

function preferredModelIndex(options: ModelPickerOption[], current: string): number {
  const idx = options.findIndex((option) => option.id === current);
  return idx >= 0 ? idx : 0;
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

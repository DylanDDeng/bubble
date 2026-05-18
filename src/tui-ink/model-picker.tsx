import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { useTheme } from "./theme.js";
import { ProviderRegistry, encodeModel, decodeModel, displayModel, isUserVisibleProvider, type ModelInfo } from "../provider-registry.js";
import { listBuiltinModels } from "../model-catalog.js";

export interface ModelPickerOption {
  id: string;
  label: string;
  group: string;
  providerBadge: string;
}

export interface ModelPickerProps {
  registry: ProviderRegistry;
  current: string;
  recent: string[];
  onSelect: (model: string) => void;
  onCancel: () => void;
}

export function ModelPicker({ registry, current, recent, onSelect, onCancel }: ModelPickerProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const maxVisible = Math.max(5, termHeight - 10);

  const [rawOptions, setRawOptions] = useState<ModelPickerOption[]>(() =>
    buildLocalModelOptions(registry, current, recent)
  );
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(() =>
    preferredModelIndex(buildLocalModelOptions(registry, current, recent), current)
  );

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
        opts.unshift({ id: current, label: displayModel(current), group: "Current", providerBadge: provider?.name || providerId || "" });
      }

      if (!cancelled) {
        setRawOptions(opts);
        setSelectedIndex((index) => {
          const currentIndex = preferredModelIndex(opts, current);
          return index === preferredModelIndex(localOptions, current) ? currentIndex : Math.min(index, Math.max(0, opts.length - 1));
        });
        setRefreshing(false);
      }
    }
    setRefreshing(true);
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
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const opt = options[selectedIndex];
      if (opt) onSelect(opt.id);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => {
        const next = q.slice(0, -1);
        setSelectedIndex(0);
        return next;
      });
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => {
        const next = q + input;
        setSelectedIndex(0);
        return next;
      });
      return;
    }
  });

  const start = Math.max(0, Math.min(selectedIndex, options.length - maxVisible));
  const visible = options.slice(start, start + maxVisible);



  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Select Model</Text>
      <SearchField query={query} placeholder="Type to search models..." />
      <Text color={theme.muted}>↑/↓ navigate · Enter select · Esc cancel · Backspace clear</Text>
      {refreshing && <Text color={theme.muted}>Refreshing remote model list...</Text>}
      <Box flexDirection="column" marginTop={1}>
        {options.length === 0 && (
          <Text color={theme.muted}>No models match "{query}"</Text>
        )}
        {visible.map((opt, i) => {
          const actualIndex = start + i;
          const isSelected = actualIndex === selectedIndex;
          return (
            <Box key={opt.id}>
              <Text color={isSelected ? theme.accent : undefined}>
                {isSelected ? "> " : "  "}
                {opt.label}
              </Text>
              <Box marginLeft={1}>
                <Text color={theme.muted} dimColor>
                  {opt.providerBadge}
                </Text>
              </Box>
              {opt.id === current && (
                <Box marginLeft={1}>
                  <Text color={theme.accent}>●</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function SearchField({ query, placeholder }: { query: string; placeholder: string }) {
  const theme = useTheme();
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setCursorVisible((v) => !v), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color={theme.accent}>{"❯ "}</Text>
      <Text>{query}</Text>
      <Text color={theme.accent} inverse={cursorVisible}> </Text>
      {!query && <Text color={theme.muted} dimColor> {placeholder}</Text>}
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
  option: ModelPickerOption,
): void {
  if (seen.has(option.id)) return;
  seen.add(option.id);
  options.push(option);
}

function preferredModelIndex(options: ModelPickerOption[], current: string): number {
  const idx = options.findIndex((option) => option.id === current);
  return idx >= 0 ? idx : 0;
}

export interface ProviderPickerProps {
  providers: Array<{ id: string; name: string; enabled: boolean }>;
  current?: string;
  onSelect: (providerId: string) => void;
  onCancel: () => void;
  title?: string;
}

export function ProviderPicker({ providers, current, onSelect, onCancel, title }: ProviderPickerProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const maxVisible = Math.max(5, termHeight - 8);

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = providers.findIndex((p) => p.id === current);
    return idx >= 0 ? idx : 0;
  });

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const p = providers[selectedIndex];
      if (p) onSelect(p.id);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(providers.length - 1, i + 1));
      return;
    }
    if (input && input.length === 1 && /[a-z]/i.test(input)) {
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
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (value.trim()) onSubmit(value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
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
  const maxVisible = Math.max(5, termHeight - 8);
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
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const skill = options[selectedIndex];
      if (skill) onSelect(skill.name);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(Math.max(0, options.length - 1), i + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => {
        const next = q.slice(0, -1);
        setSelectedIndex(0);
        return next;
      });
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => {
        const next = q + input;
        setSelectedIndex(0);
        return next;
      });
    }
  });

  const start = Math.max(0, Math.min(selectedIndex, options.length - maxVisible));
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
          return (
            <Box key={skill.name} flexDirection="column">
              <Text color={isSelected ? theme.accent : undefined}>
                {isSelected ? "> " : "  "}
                {skill.name}
              </Text>
              {skill.description && (
                <Box marginLeft={2}>
                  <Text color={theme.muted} dimColor>{skill.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

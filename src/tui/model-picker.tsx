import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { theme } from "./theme.js";
import { ProviderRegistry, encodeModel, displayModel, type ModelInfo } from "../provider-registry.js";

interface Option {
  id: string;
  label: string;
  group: string;
}

export interface ModelPickerProps {
  registry: ProviderRegistry;
  current: string;
  recent: string[];
  onSelect: (model: string) => void;
  onCancel: () => void;
}

const DEFAULT_GROUP_LIMIT = 6;

export function ModelPicker({ registry, current, recent, onSelect, onCancel }: ModelPickerProps) {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const maxVisible = Math.max(5, termHeight - 10);

  const [rawOptions, setRawOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const enabled = registry.getEnabled();
      const opts: Option[] = [];
      const seen = new Set<string>();

      // Recent first
      for (const m of recent.slice(0, 5)) {
        if (seen.has(m)) continue;
        seen.add(m);
        opts.push({ id: m, label: displayModel(m), group: "Recent" });
      }

      // Per-provider models
      for (const provider of enabled) {
        const models = await registry.listModels(provider);
        for (const m of models) {
          const fullId = encodeModel(m.providerId, m.id);
          if (seen.has(fullId)) continue;
          seen.add(fullId);
          opts.push({
            id: fullId,
            label: m.name,
            group: provider.name,
          });
        }
      }

      if (!seen.has(current)) {
        opts.unshift({ id: current, label: displayModel(current), group: "Current" });
      }

      if (!cancelled) {
        setRawOptions(opts);
        const idx = opts.findIndex((o) => o.id === current);
        setSelectedIndex(idx >= 0 ? idx : 0);
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [registry, current, recent]);

  const options = useMemo(() => {
    if (!query.trim()) {
      // Without query: limit each group to DEFAULT_GROUP_LIMIT
      const counts = new Map<string, number>();
      return rawOptions.filter((opt) => {
        if (opt.group === "Recent" || opt.group === "Current") return true;
        const count = counts.get(opt.group) || 0;
        if (count < DEFAULT_GROUP_LIMIT) {
          counts.set(opt.group, count + 1);
          return true;
        }
        return false;
      });
    }
    const q = query.toLowerCase();
    return rawOptions.filter((opt) => opt.label.toLowerCase().includes(q) || opt.group.toLowerCase().includes(q));
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

  let lastGroup = "";

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.accent}>Select Model</Text>
      <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
        <Text color={query ? undefined : theme.muted}>
          {query || "Type to search..."}
        </Text>
      </Box>
      <Text color={theme.muted}>↑/↓ navigate, Enter select, Esc cancel, Backspace clear</Text>
      {loading && <Text color={theme.muted}>Loading models...</Text>}
      {!loading && (
        <Box flexDirection="column" marginTop={1}>
          {options.length === 0 && (
            <Text color={theme.muted}>No models match "{query}"</Text>
          )}
          {visible.map((opt, i) => {
            const actualIndex = start + i;
            const isSelected = actualIndex === selectedIndex;
            const showGroup = opt.group !== lastGroup;
            lastGroup = opt.group;
            return (
              <Box key={opt.id} flexDirection="column">
                {showGroup && (
                  <Text color={theme.muted} dimColor>
                    {opt.group}
                  </Text>
                )}
                <Box>
                  <Text color={isSelected ? theme.accent : undefined}>
                    {isSelected ? "> " : "  "}
                    {opt.label}
                    {opt.id === current ? " (current)" : ""}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

export interface ProviderPickerProps {
  providers: Array<{ id: string; name: string; enabled: boolean }>;
  current?: string;
  onSelect: (providerId: string) => void;
  onCancel: () => void;
}

export function ProviderPicker({ providers, current, onSelect, onCancel }: ProviderPickerProps) {
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
    <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.accent}>Select Provider</Text>
      <Text color={theme.muted}>↑/↓ to navigate, Enter to select, Esc to cancel</Text>
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

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.accent}>Enter API Key for {providerName}</Text>
      <Text color={theme.muted}>Type the key, then press Enter. Esc to cancel.</Text>
      <Box marginTop={1} borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
        <Text>{value.replace(/./g, "*") || " "}</Text>
      </Box>
    </Box>
  );
}

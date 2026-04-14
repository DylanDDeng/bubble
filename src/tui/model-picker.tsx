import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { theme } from "./theme.js";
import { displayModel, POPULAR_MODELS } from "../config.js";

interface ModelOption {
  id: string;
  label: string;
  group: string;
}

export interface ModelPickerProps {
  current: string;
  recent: string[];
  onSelect: (model: string) => void;
  onCancel: () => void;
}

export function ModelPicker({ current, recent, onSelect, onCancel }: ModelPickerProps) {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const maxVisible = Math.max(5, termHeight - 8);

  const options: ModelOption[] = [];
  const seen = new Set<string>();

  if (recent.length > 0) {
    for (const m of recent.slice(0, 5)) {
      if (seen.has(m)) continue;
      seen.add(m);
      options.push({ id: m, label: displayModel(m), group: "Recent" });
    }
  }

  for (const m of POPULAR_MODELS) {
    if (seen.has(m)) continue;
    seen.add(m);
    options.push({ id: m, label: displayModel(m), group: "Popular" });
  }

  // Ensure current model is in the list
  if (!seen.has(current)) {
    options.unshift({ id: current, label: displayModel(current), group: "Current" });
  }

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex((o) => o.id === current);
    return idx >= 0 ? idx : 0;
  });

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
    // Quick jump with letter keys
    if (input && input.length === 1 && /[a-z0-9]/i.test(input)) {
      const char = input.toLowerCase();
      for (let i = selectedIndex + 1; i < options.length; i++) {
        if (options[i].label.toLowerCase().startsWith(char)) {
          setSelectedIndex(i);
          return;
        }
      }
      for (let i = 0; i <= selectedIndex; i++) {
        if (options[i].label.toLowerCase().startsWith(char)) {
          setSelectedIndex(i);
          return;
        }
      }
    }
  });

  const start = Math.max(0, Math.min(selectedIndex, options.length - maxVisible));
  const visible = options.slice(start, start + maxVisible);

  let lastGroup = "";

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.accent}>Select Model</Text>
      <Text color={theme.muted}>↑/↓ to navigate, Enter to select, Esc to cancel</Text>
      <Box flexDirection="column" marginTop={1}>
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
    </Box>
  );
}

export interface KeyPickerProps {
  onSubmit: (key: string) => void;
  onCancel: () => void;
}

export function KeyPicker({ onSubmit, onCancel }: KeyPickerProps) {
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
      <Text bold color={theme.accent}>Enter API Key</Text>
      <Text color={theme.muted}>Type your OpenRouter key, then press Enter. Esc to cancel.</Text>
      <Box marginTop={1} borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
        <Text>{value.replace(/./g, "*") || " "}</Text>
      </Box>
    </Box>
  );
}

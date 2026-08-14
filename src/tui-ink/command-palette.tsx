/**
 * Slash-command and MCP-server picker overlays, the local /goal & /loop
 * command table, and the shared PalettePicker list UI they render through.
 */
import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registry as slashRegistry } from "../slash-commands/index.js";
import { isGrokLocalSlashCommand } from "../external-runtime/grok-input-policy.js";
import { SkillRegistry } from "../skills/registry.js";
import type { McpManager } from "../mcp/manager.js";
import { useTheme } from "./theme.js";
import { isPrintablePickerInput } from "./model-picker.js";
import { isKeyReleaseEvent } from "./key-events.js";
import { clampWindowStartForIndex, truncate } from "./app-helpers.js";

export interface PaletteItem {
  label: string;
  detail: string;
  value: string;
  command: string;
  action?: "insert-skill";
}

export function buildCommandPaletteItems(skillRegistry: SkillRegistry, grokSessionBound = false): PaletteItem[] {
  const items = new Map<string, PaletteItem>();
  const add = (item: PaletteItem) => {
    const key = `${item.action ?? "command"}:${item.value}`;
    if (!items.has(key)) items.set(key, item);
  };

  if (!grokSessionBound) {
    for (const command of INK_LOCAL_SLASH_COMMANDS) {
      add({
        label: `/${command.name}`,
        detail: command.description,
        value: command.name,
        command: `/${command.name}`,
      });
    }
  }
  for (const command of slashRegistry.list()) {
    if (grokSessionBound && !isGrokLocalSlashCommand(command.name)) continue;
    const source = command.source === "mcp" ? " :mcp" : "";
    const sourceLabel = command.sourceLabel ? `[${command.sourceLabel}] ` : "";
    add({
      label: `/${command.name}${source}`,
      detail: `${sourceLabel}${command.description}`,
      value: command.name,
      command: `/${command.name}`,
    });
  }
  if (!grokSessionBound) {
    for (const skill of skillRegistry.summaries()) {
      add({
        label: `/${skill.name} :skill`,
        detail: `[${skill.source}] ${skill.description}`,
        value: skill.name,
        command: `/${skill.name}`,
        action: "insert-skill",
      });
    }
  }

  return [...items.values()];
}

export function buildMcpReconnectItems(mcpManager?: McpManager): PaletteItem[] {
  return (mcpManager?.getStates() ?? []).map((state) => {
    let detail: string;
    if (state.status.kind === "connected") {
      const tools = state.status.tools.length;
      const prompts = state.status.prompts.length;
      detail = `connected · ${tools} tool${tools === 1 ? "" : "s"} · ${prompts} prompt${prompts === 1 ? "" : "s"}`;
    } else if (state.status.kind === "failed") {
      detail = `failed · ${state.status.error}`;
    } else {
      detail = "disabled";
    }
    return {
      label: state.name,
      detail,
      value: state.name,
      command: `/mcp reconnect ${state.name}`,
    };
  });
}

export function CommandPalette({
  items,
  terminalColumns,
  terminalRows,
  onSelect,
  onCancel,
}: {
  items: PaletteItem[];
  terminalColumns: number;
  terminalRows: number;
  onSelect: (item: PaletteItem) => void;
  onCancel: () => void;
}) {
  return (
    <PalettePicker
      title="Commands"
      hint="Type to filter · Up/Down choose · Enter run · Esc cancel"
      emptyText="No commands found."
      items={items}
      terminalColumns={terminalColumns}
      terminalRows={terminalRows}
      searchable
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}

export function McpReconnectPicker({
  items,
  terminalColumns,
  terminalRows,
  onSelect,
  onCancel,
}: {
  items: PaletteItem[];
  terminalColumns: number;
  terminalRows: number;
  onSelect: (item: PaletteItem) => void;
  onCancel: () => void;
}) {
  return (
    <PalettePicker
      title="MCP servers"
      hint="Up/Down choose · Enter or r reconnect · Esc cancel"
      emptyText="No MCP servers configured."
      items={items}
      terminalColumns={terminalColumns}
      terminalRows={terminalRows}
      reconnectAlias
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}

function PalettePicker({
  title,
  hint,
  emptyText,
  items,
  terminalColumns,
  terminalRows,
  searchable = false,
  reconnectAlias = false,
  onSelect,
  onCancel,
}: {
  title: string;
  hint: string;
  emptyText: string;
  items: PaletteItem[];
  terminalColumns: number;
  terminalRows: number;
  searchable?: boolean;
  reconnectAlias?: boolean;
  onSelect: (item: PaletteItem) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const maxVisible = Math.max(5, Math.min(12, terminalRows - 10));
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      item.label.toLowerCase().includes(needle) ||
      item.detail.toLowerCase().includes(needle) ||
      item.value.toLowerCase().includes(needle)
    );
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(Math.max(0, filtered.length - 1), current));
  }, [filtered.length]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return || (reconnectAlias && input.toLowerCase() === "r")) {
      const item = filtered[selectedIndex];
      if (item) onSelect(item);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((index) => Math.min(Math.max(0, filtered.length - 1), index + 1));
      return;
    }
    if (key.pageUp) {
      setSelectedIndex((index) => Math.max(0, index - maxVisible));
      return;
    }
    if (key.pageDown) {
      setSelectedIndex((index) => Math.min(Math.max(0, filtered.length - 1), index + maxVisible));
      return;
    }
    if (!searchable) return;
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      return;
    }
    if (isPrintablePickerInput(input) && !key.ctrl && !key.meta) {
      setQuery((current) => current + input);
    }
  });

  const start = clampWindowStartForIndex(filtered.length, selectedIndex, maxVisible);
  const visible = filtered.slice(start, start + maxVisible);
  const labelWidth = Math.max(18, Math.min(36, Math.floor(terminalColumns * 0.32)));
  const detailWidth = Math.max(20, terminalColumns - labelWidth - 10);

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>{title}</Text>
      {searchable && (
        <Text color={theme.muted}>
          Filter: <Text color={theme.userMessageText}>{query || " "}</Text>
        </Text>
      )}
      <Text color={theme.muted}>{hint}</Text>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 && <Text color={theme.muted}>{emptyText}</Text>}
        {visible.map((item, offset) => {
          const actualIndex = start + offset;
          const selected = actualIndex === selectedIndex;
          return (
            <Box key={`${item.action ?? "command"}-${item.value}`}>
              <Text color={selected ? theme.accent : undefined}>
                {selected ? "> " : "  "}
                {truncate(item.label, labelWidth)}
              </Text>
              <Text color={theme.muted}> {truncate(item.detail, detailWidth)}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export const INK_LOCAL_SLASH_COMMANDS = [
  {
    name: "goal",
    description: "Set/manage an autonomous goal (/goal <objective>|clear|pause|resume|edit)",
  },
  {
    name: "loop",
    description: "Run a prompt on a recurring interval (/loop 5m <prompt>|list|stop [id])",
  },
] as const;

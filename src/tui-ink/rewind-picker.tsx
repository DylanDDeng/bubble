/**
 * /rewind checkpoint picker: lists user turns with touched-file counts and
 * cycles the restore scope (chat + files / chat only / files only).
 */
import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionManager, UserTurn } from "../session.js";
import { useTheme } from "./theme.js";
import { isKeyReleaseEvent } from "./key-events.js";
import { clampWindowStartForIndex, truncate } from "./app-helpers.js";

type RewindScope = "all" | "chat" | "code";

const REWIND_SCOPE_ORDER: RewindScope[] = ["all", "chat", "code"];
const REWIND_SCOPE_LABEL: Record<RewindScope, string> = {
  all: "chat + files",
  chat: "chat only",
  code: "files only",
};

function rewindCommand(turnIndex: number, scope: RewindScope): string {
  const base = `/rewind ${turnIndex + 1}`;
  if (scope === "chat") return `${base} --chat`;
  if (scope === "code") return `${base} --code`;
  return base;
}

function cycleRewindScope(scope: RewindScope, direction: 1 | -1): RewindScope {
  const index = REWIND_SCOPE_ORDER.indexOf(scope);
  return REWIND_SCOPE_ORDER[
    (index + direction + REWIND_SCOPE_ORDER.length) % REWIND_SCOPE_ORDER.length
  ]!;
}

export function RewindPicker({
  sessionManager,
  terminalColumns,
  terminalRows,
  onSelect,
  onCancel,
}: {
  sessionManager: SessionManager;
  terminalColumns: number;
  terminalRows: number;
  onSelect: (command: string) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const turns = useMemo(() => sessionManager.listUserTurns(), [sessionManager]);
  const checkpoints = useMemo(() => sessionManager.getCheckpoints(), [sessionManager]);
  const fileCounts = useMemo(() => {
    const entries = checkpoints.listEntries();
    const byTurn = new Map<string, Set<string>>();
    for (const entry of entries) {
      const files = byTurn.get(entry.turn);
      if (files) files.add(entry.path);
      else byTurn.set(entry.turn, new Set([entry.path]));
    }
    return new Map(turns.map((turn) => [turn.id, byTurn.get(turn.id)?.size ?? 0]));
  }, [checkpoints, turns]);
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, turns.length - 1));
  const [scope, setScope] = useState<RewindScope>("all");
  const maxVisible = Math.max(4, Math.min(10, terminalRows - 10));

  useEffect(() => {
    setSelectedIndex((current) => Math.min(Math.max(0, turns.length - 1), current));
  }, [turns.length]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (turns[selectedIndex]) onSelect(rewindCommand(selectedIndex, scope));
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((index) => Math.min(Math.max(0, turns.length - 1), index + 1));
      return;
    }
    if (key.pageUp) {
      setSelectedIndex((index) => Math.max(0, index - maxVisible));
      return;
    }
    if (key.pageDown) {
      setSelectedIndex((index) => Math.min(Math.max(0, turns.length - 1), index + maxVisible));
      return;
    }
    if (key.tab || key.rightArrow || input === "l") {
      setScope((current) => cycleRewindScope(current, 1));
      return;
    }
    if (key.leftArrow || input === "h") {
      setScope((current) => cycleRewindScope(current, -1));
    }
  });

  const start = clampWindowStartForIndex(turns.length, selectedIndex, maxVisible);
  const visibleTurns = turns.slice(start, start + maxVisible);
  const previewWidth = Math.max(18, Math.min(76, terminalColumns - 34));

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Rewind</Text>
      <Text color={theme.muted}>
        Restore: <Text color={theme.accent}>{REWIND_SCOPE_LABEL[scope]}</Text>
        {"  ·  "}
        {turns.length} point{turns.length === 1 ? "" : "s"}
      </Text>
      <Text color={theme.muted}>Up/Down choose · Left/Right scope · Enter rewind · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {turns.length === 0 && <Text color={theme.muted}>Nothing to rewind: no user messages in this session.</Text>}
        {visibleTurns.map((turn, offset) => {
          const actualIndex = start + offset;
          const isSelected = actualIndex === selectedIndex;
          const touched = fileCounts.get(turn.id) ?? 0;
          return (
            <RewindRow
              key={turn.id}
              turn={turn}
              turnNumber={actualIndex + 1}
              selected={isSelected}
              fileCount={touched}
              previewWidth={previewWidth}
            />
          );
        })}
      </Box>
    </Box>
  );
}

function RewindRow({
  turn,
  turnNumber,
  selected,
  fileCount,
  previewWidth,
}: {
  turn: UserTurn;
  turnNumber: number;
  selected: boolean;
  fileCount: number;
  previewWidth: number;
}) {
  const theme = useTheme();
  const time = new Date(turn.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fileNote = fileCount > 0 ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"}` : "";
  return (
    <Box>
      <Text color={selected ? theme.accent : undefined}>
        {selected ? "> " : "  "}
        {String(turnNumber).padStart(2, " ")} {time} {truncate(turn.preview, previewWidth)}
      </Text>
      <Text color={theme.muted}>{fileNote}</Text>
    </Box>
  );
}

import { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { isKeyReleaseEvent } from "./key-events.js";
import { useTheme } from "./theme.js";
import { formatRelativeTime } from "./recent-activity.js";
import type { SessionSummary } from "../session.js";
import { padVisual, truncateVisual } from "../text-display.js";

export type SessionPickerMode = "current" | "all";

export interface SessionPickerProps {
  currentCwd: string;
  currentSessions: SessionSummary[];
  allSessions: SessionSummary[];
  onSelect: (file: string) => void;
  onCancel: () => void;
}

interface Row {
  type: "header" | "session";
  label?: string;
  session?: SessionSummary;
}

export function SessionPicker({ currentCwd, currentSessions, allSessions, onSelect, onCancel }: SessionPickerProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const termWidth = stdout?.columns || 80;
  const maxVisible = Math.max(6, termHeight - 10);

  const [mode, setMode] = useState<SessionPickerMode>("current");
  const [selectedSessionIdx, setSelectedSessionIdx] = useState(0);

  const rows = useMemo(() => buildRows(mode, currentCwd, currentSessions, allSessions), [mode, currentCwd, currentSessions, allSessions]);
  const sessionRowIndices = useMemo(
    () => rows.map((row, i) => (row.type === "session" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  const clampedIdx = sessionRowIndices.length === 0
    ? 0
    : Math.min(selectedSessionIdx, sessionRowIndices.length - 1);
  const selectedRowIndex = sessionRowIndices[clampedIdx] ?? -1;

  useInput((_input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      setMode((m) => (m === "current" ? "all" : "current"));
      setSelectedSessionIdx(0);
      return;
    }
    if (key.return) {
      const row = rows[selectedRowIndex];
      if (row?.type === "session" && row.session) onSelect(row.session.file);
      return;
    }
    if (key.upArrow) {
      setSelectedSessionIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedSessionIdx((i) => Math.min(Math.max(0, sessionRowIndices.length - 1), i + 1));
      return;
    }
  });

  // Window the visible rows around the selected session.
  const start = clampWindowStart(rows, selectedRowIndex, maxVisible);
  const visible = rows.slice(start, start + maxVisible);

  const modeLabel = mode === "current" ? "Current dir" : "All directories";
  const totalSessions = sessionRowIndices.length;

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Resume session</Text>
      <Text color={theme.muted}>
        View: <Text color={theme.accent}>{modeLabel}</Text>
        {"  ·  "}
        {totalSessions} session{totalSessions === 1 ? "" : "s"}
      </Text>
      <Text color={theme.muted}>↑/↓ navigate · Enter resume · Tab toggle scope · Esc start fresh</Text>
      <Box flexDirection="column" marginTop={1}>
        {totalSessions === 0 && (
          <Text color={theme.muted}>
            {mode === "current"
              ? "No previous sessions in this directory."
              : "No previous sessions found."}
          </Text>
        )}
        {visible.map((row, i) => {
          const actualIndex = start + i;
          if (row.type === "header") {
            return (
              <Box key={`h-${actualIndex}`} marginTop={i === 0 ? 0 : 1}>
                <Text color={theme.muted} bold>{row.label}</Text>
              </Box>
            );
          }
          const session = row.session!;
          const isSelected = actualIndex === selectedRowIndex;
          const time = padVisual(formatRelativeTime(session.mtime), 9);
          const titleWidth = Math.max(20, Math.min(80, termWidth - 30));
          return (
            <Box key={session.file}>
              <Text color={isSelected ? theme.accent : undefined}>
                {isSelected ? "> " : "  "}
                {time}
                {"  "}
                {padVisual(truncateVisual(session.title, titleWidth), titleWidth)}
              </Text>
              <Box marginLeft={1}>
                <Text color={theme.muted} dimColor>
                  · {session.messageCount} msg{session.messageCount === 1 ? "" : "s"}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function buildRows(
  mode: SessionPickerMode,
  currentCwd: string,
  currentSessions: SessionSummary[],
  allSessions: SessionSummary[],
): Row[] {
  if (mode === "current") {
    if (currentSessions.length === 0) return [];
    return [
      { type: "header", label: currentCwd },
      ...currentSessions.map((session) => ({ type: "session" as const, session })),
    ];
  }
  const grouped = new Map<string, SessionSummary[]>();
  for (const session of allSessions) {
    const key = session.cwdLabel;
    const list = grouped.get(key);
    if (list) list.push(session);
    else grouped.set(key, [session]);
  }
  const sortedGroups = Array.from(grouped.entries()).sort((a, b) => {
    if (a[0] === currentCwd) return -1;
    if (b[0] === currentCwd) return 1;
    const aLatest = a[1][0]?.mtime ?? 0;
    const bLatest = b[1][0]?.mtime ?? 0;
    return bLatest - aLatest;
  });
  const rows: Row[] = [];
  for (const [label, sessions] of sortedGroups) {
    rows.push({ type: "header", label });
    for (const session of sessions) rows.push({ type: "session", session });
  }
  return rows;
}

function clampWindowStart(rows: Row[], selectedRowIndex: number, maxVisible: number): number {
  if (rows.length <= maxVisible) return 0;
  if (selectedRowIndex < 0) return 0;
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedRowIndex - half);
  if (start + maxVisible > rows.length) start = rows.length - maxVisible;
  return Math.max(0, start);
}

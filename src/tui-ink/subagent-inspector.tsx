/**
 * Full-screen subagent inspector (Ctrl+G / /agents).
 *
 * Two-level drill-in modeled on Claude Code's workflow view: a grouped list of
 * subagents (each spawn_agent is one member; each agent_team/agent_batch is a
 * group of members) → a per-member working-trace detail (its task, every tool
 * step it ran, and its final summary/error). Data is live: app.tsx derives the
 * groups from the message state each render, so the inspector reflects running
 * members as their events stream in.
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { isKeyReleaseEvent } from "./key-events.js";
import { useTheme } from "./theme.js";
import { padVisual, truncateVisual } from "../text-display.js";
import {
  latestSubagentNote,
  subagentDescriptor,
  subagentLabel,
  subagentStatusColor,
  subagentSummary,
  type SubagentDisplay,
  type SubagentGroup,
} from "./subagent-view.js";

export type { SubagentGroup };

export interface SubagentInspectorProps {
  groups: SubagentGroup[];
  onCancel: () => void;
}

const STATUS_FILTERS: Array<string | null> = [null, "running", "queued", "completed", "failed"];

type Row =
  | { type: "header"; group: SubagentGroup }
  | { type: "member"; group: SubagentGroup; member: SubagentDisplay; key: string };

export function SubagentInspector({ groups, onCancel }: SubagentInspectorProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const termWidth = stdout?.columns || 80;
  const maxVisible = Math.max(6, termHeight - 12);

  const [view, setView] = useState<"list" | "detail">("list");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [detailScroll, setDetailScroll] = useState(0);
  const [filterIdx, setFilterIdx] = useState(0);
  const statusFilter = STATUS_FILTERS[filterIdx];

  const allMembers = useMemo(() => groups.flatMap((g) => g.members), [groups]);

  // Flat row list: a header per multi-member group, then its (filtered) members.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const group of groups) {
      const members = statusFilter
        ? group.members.filter((m) => (m.status ?? "running") === statusFilter)
        : group.members;
      if (members.length === 0) continue;
      if (group.kind !== "single") out.push({ type: "header", group });
      members.forEach((member, i) => {
        out.push({ type: "member", group, member, key: member.subAgentId ?? `${group.id}:${i}` });
      });
    }
    return out;
  }, [groups, statusFilter]);

  const memberRowIndices = useMemo(
    () => rows.map((row, i) => (row.type === "member" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );
  const clampedIdx = memberRowIndices.length === 0 ? 0 : Math.min(selectedIdx, memberRowIndices.length - 1);
  const selectedRowIndex = memberRowIndices[clampedIdx] ?? -1;
  const selectedRow = rows[selectedRowIndex];
  const selectedMember = selectedRow?.type === "member" ? selectedRow.member : undefined;

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;

    if (view === "detail") {
      if (key.escape || key.leftArrow) {
        setView("list");
        return;
      }
      if (key.upArrow || input === "k") {
        setDetailScroll((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setDetailScroll((s) => s + 1);
        return;
      }
      return;
    }

    // list view
    if (key.escape) {
      onCancel();
      return;
    }
    if (input === "f") {
      setFilterIdx((i) => (i + 1) % STATUS_FILTERS.length);
      setSelectedIdx(0);
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(Math.max(0, memberRowIndices.length - 1), i + 1));
      return;
    }
    if ((key.return || key.rightArrow) && selectedMember) {
      setDetailScroll(0);
      setView("detail");
      return;
    }
  });

  if (groups.length === 0) {
    return (
      <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="round" borderColor={theme.borderActive}>
        <Text bold color={theme.accent}>Subagents</Text>
        <Text color={theme.muted}>No subagents have been spawned yet. Esc to close.</Text>
      </Box>
    );
  }

  if (view === "detail" && selectedMember) {
    return (
      <SubagentDetail
        member={selectedMember}
        group={selectedRow?.type === "member" ? selectedRow.group : undefined}
        scroll={detailScroll}
        maxVisible={maxVisible}
        termWidth={termWidth}
      />
    );
  }

  // ---- list view ----
  const start = clampWindowStart(rows, selectedRowIndex, maxVisible);
  const visible = rows.slice(start, start + maxVisible);
  const labelWidth = 12;
  const descriptorWidth = Math.max(20, Math.min(46, termWidth - 48));

  return (
    <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="round" borderColor={theme.borderActive}>
      <Text bold color={theme.accent}>Subagents · working traces</Text>
      <Text color={theme.muted}>
        {allMembers.length} member{allMembers.length === 1 ? "" : "s"} · {subagentSummary(allMembers)}
        {statusFilter ? `  ·  filter: ${statusFilter}` : ""}
      </Text>
      <Text color={theme.muted}>↑/↓ select · Enter/→ open trace · f filter status · Esc close</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 && (
          <Text color={theme.muted}>No members match the current filter.</Text>
        )}
        {visible.map((row, i) => {
          const actualIndex = start + i;
          if (row.type === "header") {
            return (
              <Box key={`h-${actualIndex}`} marginTop={i === 0 ? 0 : 1}>
                <Text bold color={theme.muted}>
                  ▦ {row.group.kind} · {truncateVisual(row.group.label, termWidth - 18)} ({row.group.members.length})
                </Text>
              </Box>
            );
          }
          const member = row.member;
          const status = member.status ?? "running";
          const isSelected = actualIndex === selectedRowIndex;
          const note = truncateVisual(latestSubagentNote(member), Math.max(12, termWidth - labelWidth - descriptorWidth - 18));
          return (
            <Box key={row.key}>
              <Text color={isSelected ? theme.accent : undefined}>{isSelected ? "> " : "  "}</Text>
              <Text color={subagentStatusColor(status, theme)}>{padVisual(truncateVisual(subagentLabel(member), labelWidth), labelWidth)}</Text>
              <Text color={theme.traceAction}> {padVisual(truncateVisual(subagentDescriptor(member), descriptorWidth), descriptorWidth)}</Text>
              <Text color={subagentStatusColor(status, theme)}> {padVisual(status, 9)}</Text>
              {note && <Text color={member.error ? theme.error : theme.traceDetail}> {note}</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function SubagentDetail({
  member,
  group,
  scroll,
  maxVisible,
  termWidth,
}: {
  member: SubagentDisplay;
  group: SubagentGroup | undefined;
  scroll: number;
  maxVisible: number;
  termWidth: number;
}) {
  const theme = useTheme();
  const status = member.status ?? "running";
  const wrapWidth = Math.max(20, termWidth - 6);

  // Build the scrollable body: task → working trace (every tool step) → summary/error.
  const body: Array<{ text: string; color?: string; dim?: boolean }> = [];
  if (member.task) {
    body.push({ text: "Task", color: theme.muted });
    for (const line of wrapText(member.task, wrapWidth)) body.push({ text: `  ${line}` });
    body.push({ text: "" });
  }
  body.push({ text: `Working trace (${member.toolNotes?.length ?? 0} steps)`, color: theme.muted });
  const notes = member.toolNotes?.filter(Boolean) ?? [];
  if (notes.length === 0) {
    body.push({ text: "  (no tool steps recorded yet)", dim: true });
  } else {
    notes.forEach((noteRaw, i) => {
      const note = noteRaw.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
      const wrapped = wrapText(`${String(i + 1).padStart(2, " ")}. ${note}`, wrapWidth);
      wrapped.forEach((line, j) => body.push({ text: `  ${j === 0 ? line : `    ${line}`}`, color: theme.traceDetail }));
    });
  }
  if (member.error) {
    body.push({ text: "" });
    body.push({ text: "Error", color: theme.error });
    for (const line of wrapText(member.error, wrapWidth)) body.push({ text: `  ${line}`, color: theme.error });
  } else if (member.summary) {
    body.push({ text: "" });
    body.push({ text: "Summary", color: theme.muted });
    for (const line of wrapText(member.summary, wrapWidth)) body.push({ text: `  ${line}` });
  }

  const maxScroll = Math.max(0, body.length - maxVisible);
  const clampedScroll = Math.min(scroll, maxScroll);
  const visible = body.slice(clampedScroll, clampedScroll + maxVisible);

  return (
    <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="round" borderColor={theme.borderActive}>
      <Box>
        <Text bold color={theme.accent}>{subagentLabel(member)}</Text>
        <Text color={theme.traceAction}> {subagentDescriptor(member, true)}</Text>
        <Text color={subagentStatusColor(status, theme)}>  {status}</Text>
        {group && group.kind !== "single" && <Text color={theme.muted}>  · {group.kind} “{truncateVisual(group.label, 28)}”</Text>}
      </Box>
      <Text color={theme.muted}>↑/↓ or j/k scroll · ←/Esc back{maxScroll > 0 ? `  ·  ${clampedScroll + 1}-${Math.min(clampedScroll + maxVisible, body.length)}/${body.length}` : ""}</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, i) => (
          <Text key={i} color={line.color} dimColor={line.dim}>{line.text || " "}</Text>
        ))}
      </Box>
    </Box>
  );
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    let line = rawLine;
    if (line.length === 0) {
      out.push("");
      continue;
    }
    while (line.length > width) {
      // Prefer breaking at the last space within the width window.
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

function clampWindowStart(rows: Row[], selectedRowIndex: number, maxVisible: number): number {
  if (rows.length <= maxVisible) return 0;
  if (selectedRowIndex < 0) return 0;
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedRowIndex - half);
  if (start + maxVisible > rows.length) start = rows.length - maxVisible;
  return Math.max(0, start);
}

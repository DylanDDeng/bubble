import React from "react";
import { Box, Text } from "ink";
import type { Todo } from "../types.js";
import { theme } from "./theme.js";

interface TodosPanelProps {
  todos: Todo[];
  terminalColumns: number;
}

const MAX_ROWS = 8;

export function TodosPanel({ todos, terminalColumns }: TodosPanelProps) {
  if (todos.length === 0) {
    return null;
  }

  const rows = selectVisibleRows(todos);
  const hiddenCount = todos.length - rows.length;
  const contentWidth = Math.max(20, terminalColumns - 4);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent} bold>
        ● Todos
      </Text>
      {rows.map((todo, index) => (
        <TodoRow key={index} todo={todo} maxWidth={contentWidth} />
      ))}
      {hiddenCount > 0 && (
        <Text color={theme.muted}>
          ... {hiddenCount} more item{hiddenCount === 1 ? "" : "s"} hidden
        </Text>
      )}
    </Box>
  );
}

function selectVisibleRows(todos: Todo[]): Todo[] {
  if (todos.length <= MAX_ROWS) {
    return todos;
  }
  // Prefer to show: all in_progress, the last N completed just before current, and upcoming pending.
  const inProgressIdx = todos.findIndex((t) => t.status === "in_progress");
  const anchor = inProgressIdx >= 0 ? inProgressIdx : todos.findIndex((t) => t.status === "pending");
  const pivot = anchor >= 0 ? anchor : 0;
  const half = Math.floor(MAX_ROWS / 2);
  let start = Math.max(0, pivot - half);
  let end = Math.min(todos.length, start + MAX_ROWS);
  if (end - start < MAX_ROWS) {
    start = Math.max(0, end - MAX_ROWS);
  }
  return todos.slice(start, end);
}

function TodoRow({ todo, maxWidth }: { todo: Todo; maxWidth: number }) {
  const { glyph, color, dim, label } = statusStyle(todo);
  const text = label || todo.content;
  const trimmed = text.length > maxWidth - 4 ? text.slice(0, maxWidth - 5) + "…" : text;
  return (
    <Box height={1}>
      <Text color={color} dimColor={dim}>
        {glyph} {trimmed}
      </Text>
    </Box>
  );
}

function statusStyle(todo: Todo): { glyph: string; color: string; dim: boolean; label: string } {
  if (todo.status === "completed") {
    return { glyph: "✔", color: theme.muted, dim: true, label: todo.content };
  }
  if (todo.status === "in_progress") {
    return { glyph: "▶", color: theme.accent, dim: false, label: todo.activeForm || todo.content };
  }
  return { glyph: "○", color: theme.muted, dim: false, label: todo.content };
}

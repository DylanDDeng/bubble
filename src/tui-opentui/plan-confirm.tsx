/** @jsxImportSource @opentui/react */
import React, { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "./theme.js";
import { MarkdownContent } from "./markdown.js";

interface PlanConfirmProps {
  initialPlan: string;
  onApprove: (plan: string) => void;
  onReject: (reason?: string) => void;
}

type Stage = "view" | "edit";

export function PlanConfirm({ initialPlan, onApprove, onReject }: PlanConfirmProps) {
  const theme = useTheme();
  const [stage, setStage] = useState<Stage>("view");
  const [draft, setDraft] = useState(initialPlan);
  const [cursor, setCursor] = useState(initialPlan.length);

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (stage === "view") {
      if (key.name === "escape" || key.name === "n" || key.name === "N") {
        onReject();
        return;
      }
      if (key.name === "y" || key.name === "Y" || key.name === "return") {
        onApprove(initialPlan);
        return;
      }
      if (key.name === "e" || key.name === "E") {
        setStage("edit");
        return;
      }
      return;
    }

    // edit stage
    if (key.name === "escape") {
      setDraft(initialPlan);
      setCursor(initialPlan.length);
      setStage("view");
      return;
    }
    if (key.ctrl && (key.name === "s" || key.name === "d")) {
      const finalText = draft.trim();
      if (!finalText) {
        return;
      }
      onApprove(finalText);
      return;
    }
    if (key.name === "return") {
      // Enter inserts a newline (multi-line editor).
      insertAtCursor("\n");
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      if (cursor > 0) {
        setDraft((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (key.name === "left") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "right") {
      setCursor((c) => Math.min(draft.length, c + 1));
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const before = draft.slice(0, cursor);
      const after = draft.slice(cursor);
      const beforeLines = before.split("\n");
      const afterLines = after.split("\n");
      const currentCol = beforeLines[beforeLines.length - 1].length;
      if (key.name === "up" && beforeLines.length > 1) {
        const prevLine = beforeLines[beforeLines.length - 2];
        const col = Math.min(currentCol, prevLine.length);
        const newCursor = before.length - beforeLines[beforeLines.length - 1].length - 1 - (prevLine.length - col);
        setCursor(Math.max(0, newCursor));
      } else if (key.name === "down" && afterLines.length > 1) {
        const nextLine = afterLines[1];
        const col = Math.min(currentCol, nextLine.length);
        const newCursor = before.length + afterLines[0].length + 1 + col;
        setCursor(Math.min(draft.length, newCursor));
      }
      return;
    }
    if (key.name && key.name.length === 1) {
      insertAtCursor(key.name);
    }
  });

  function insertAtCursor(text: string) {
    setDraft((prev) => prev.slice(0, cursor) + text + prev.slice(cursor));
    setCursor((c) => c + text.length);
  }

  if (stage === "view") {
    return (
      <box
        style={{
          flexDirection: "column",
          border: true,
          borderColor: theme.accent,
          paddingLeft: 1,
          paddingRight: 1,
          marginTop: 1,
          marginBottom: 1,
        }}
      >
        <text fg={theme.accent} attributes={1}>
          Proposed plan
        </text>
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <MarkdownContent content={initialPlan} />
        </box>
        <box style={{ marginTop: 1, flexDirection: "row" }}>
          <text fg={theme.accent} attributes={1}>y</text>
          <text fg={theme.muted}> approve   </text>
          <text fg={theme.accent} attributes={1}>e</text>
          <text fg={theme.muted}> edit   </text>
          <text fg={theme.accent} attributes={1}>n</text>
          <text fg={theme.muted}>/</text>
          <text fg={theme.accent} attributes={1}>esc</text>
          <text fg={theme.muted}> reject</text>
        </box>
      </box>
    );
  }

  // edit stage
  const lines = draft.split("\n");
  const beforeCursor = draft.slice(0, cursor);
  const cursorLineIndex = beforeCursor.split("\n").length - 1;
  const cursorCol = beforeCursor.split("\n").pop()?.length || 0;

  return (
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderColor: theme.accent,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        marginBottom: 1,
      }}
    >
      <text fg={theme.accent} attributes={1}>
        Edit plan
      </text>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        {lines.map((line, index) => {
          if (index !== cursorLineIndex) {
            return (
              <text key={index}>{line || " "}</text>
            );
          }
          const safe = line || " ";
          return (
            <box key={index} style={{ flexDirection: "row" }}>
              <text>{safe.slice(0, cursorCol)}</text>
              <text bg="white" fg="black">
                {safe[cursorCol] || " "}
              </text>
              <text>{safe.slice(cursorCol + 1)}</text>
            </box>
          );
        })}
      </box>
      <box style={{ marginTop: 1, flexDirection: "row" }}>
        <text fg={theme.accent} attributes={1}>⌃S</text>
        <text fg={theme.muted}> save & approve   </text>
        <text fg={theme.accent} attributes={1}>esc</text>
        <text fg={theme.muted}> cancel edit</text>
      </box>
    </box>
  );
}
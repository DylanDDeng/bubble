import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";
import { MarkdownContent } from "./markdown.js";

interface PlanConfirmProps {
  initialPlan: string;
  onApprove: (plan: string) => void;
  onReject: (reason?: string) => void;
}

type Stage = "view" | "edit";

export function PlanConfirm({ initialPlan, onApprove, onReject }: PlanConfirmProps) {
  const [stage, setStage] = useState<Stage>("view");
  const [draft, setDraft] = useState(initialPlan);
  const [cursor, setCursor] = useState(initialPlan.length);

  useInput((input, key) => {
    if (stage === "view") {
      if (key.escape || input === "n" || input === "N") {
        onReject();
        return;
      }
      if (input === "y" || input === "Y" || key.return) {
        onApprove(initialPlan);
        return;
      }
      if (input === "e" || input === "E") {
        setStage("edit");
        return;
      }
      return;
    }

    // edit stage
    if (key.escape) {
      setDraft(initialPlan);
      setCursor(initialPlan.length);
      setStage("view");
      return;
    }
    if (key.ctrl && (input === "s" || input === "d")) {
      const finalText = draft.trim();
      if (!finalText) {
        return;
      }
      onApprove(finalText);
      return;
    }
    if (key.return) {
      // Enter inserts a newline (multi-line editor).
      insertAtCursor("\n");
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setDraft((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(draft.length, c + 1));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const before = draft.slice(0, cursor);
      const after = draft.slice(cursor);
      const beforeLines = before.split("\n");
      const afterLines = after.split("\n");
      const currentCol = beforeLines[beforeLines.length - 1].length;
      if (key.upArrow && beforeLines.length > 1) {
        const prevLine = beforeLines[beforeLines.length - 2];
        const col = Math.min(currentCol, prevLine.length);
        const newCursor = before.length - beforeLines[beforeLines.length - 1].length - 1 - (prevLine.length - col);
        setCursor(Math.max(0, newCursor));
      } else if (key.downArrow && afterLines.length > 1) {
        const nextLine = afterLines[1];
        const col = Math.min(currentCol, nextLine.length);
        const newCursor = before.length + afterLines[0].length + 1 + col;
        setCursor(Math.min(draft.length, newCursor));
      }
      return;
    }
    if (input) {
      insertAtCursor(input);
    }
  });

  function insertAtCursor(text: string) {
    setDraft((prev) => prev.slice(0, cursor) + text + prev.slice(cursor));
    setCursor((c) => c + text.length);
  }

  if (stage === "view") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
        <Text color={theme.accent} bold>
          Proposed plan
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <MarkdownContent content={initialPlan} />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>
            <Text color={theme.accent} bold>y</Text> approve &nbsp;&nbsp;
            <Text color={theme.accent} bold>e</Text> edit &nbsp;&nbsp;
            <Text color={theme.accent} bold>n</Text>/<Text color={theme.accent} bold>esc</Text> reject
          </Text>
        </Box>
      </Box>
    );
  }

  // edit stage
  const lines = draft.split("\n");
  const beforeCursor = draft.slice(0, cursor);
  const cursorLineIndex = beforeCursor.split("\n").length - 1;
  const cursorCol = beforeCursor.split("\n").pop()?.length || 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
      <Text color={theme.accent} bold>
        Edit plan
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, index) => {
          if (index !== cursorLineIndex) {
            return (
              <Text key={index}>{line || " "}</Text>
            );
          }
          const safe = line || " ";
          return (
            <Box key={index}>
              <Text>{safe.slice(0, cursorCol)}</Text>
              <Text backgroundColor="white" color="black">
                {safe[cursorCol] || " "}
              </Text>
              <Text>{safe.slice(cursorCol + 1)}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          <Text color={theme.accent} bold>⌃S</Text> save & approve &nbsp;&nbsp;
          <Text color={theme.accent} bold>esc</Text> cancel edit
        </Text>
      </Box>
    </Box>
  );
}


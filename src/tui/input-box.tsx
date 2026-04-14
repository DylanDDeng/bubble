import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";

interface InputBoxProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
}

const MIN_VISIBLE_LINES = 3;
const MAX_VISIBLE_LINES = 5;
const PADDING_X = 1;

export function InputBox({ onSubmit, disabled }: InputBoxProps) {
  const { stdout } = useStdout();
  const width = stdout.columns || 80;

  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      if (key.shift || key.ctrl || key.meta) {
        const before = text.slice(0, cursor);
        const after = text.slice(cursor);
        setText(before + "\n" + after);
        setCursor(cursor + 1);
      } else {
        onSubmit(text);
        setText("");
        setCursor(0);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        const before = text.slice(0, cursor - 1);
        const after = text.slice(cursor);
        setText(before + after);
        setCursor(cursor - 1);
      }
      return;
    }

    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(text.length, cursor + 1));
      return;
    }
    if (key.upArrow) {
      const before = text.slice(0, cursor);
      const lines = before.split("\n");
      if (lines.length > 1) {
        const currentLine = lines[lines.length - 1];
        const prevLine = lines[lines.length - 2];
        const targetCol = Math.min(currentLine.length, prevLine.length);
        const newCursor = before.length - currentLine.length - 1 - (prevLine.length - targetCol);
        setCursor(Math.max(0, newCursor));
      }
      return;
    }
    if (key.downArrow) {
      const before = text.slice(0, cursor);
      const after = text.slice(cursor);
      const linesBefore = before.split("\n");
      const linesAfter = after.split("\n");
      if (linesAfter.length > 1) {
        const currentLine = linesBefore[linesBefore.length - 1];
        const nextLine = linesAfter[1];
        const targetCol = Math.min(currentLine.length, nextLine.length);
        const newCursor = before.length + linesAfter[0].length + 1 + targetCol;
        setCursor(Math.min(text.length, newCursor));
      }
      return;
    }

    if (input) {
      const before = text.slice(0, cursor);
      const after = text.slice(cursor);
      setText(before + input + after);
      setCursor(cursor + input.length);
    }
  });

  const lines = text.split("\n");
  const beforeCursor = text.slice(0, cursor);
  const cursorLineIndex = beforeCursor.split("\n").length - 1;
  const cursorCol = beforeCursor.split("\n").pop()?.length || 0;

  const totalLines = Math.max(lines.length, 1);
  const visibleLines = Math.min(Math.max(totalLines, MIN_VISIBLE_LINES), MAX_VISIBLE_LINES);

  // Scroll offset: keep cursor line in view
  let scrollOffset = 0;
  if (totalLines > visibleLines) {
    scrollOffset = Math.min(
      Math.max(cursorLineIndex - Math.floor(visibleLines / 2), 0),
      totalLines - visibleLines
    );
  }

  const displayedLines = [];
  for (let i = 0; i < visibleLines; i++) {
    const lineIndex = scrollOffset + i;
    displayedLines.push({
      text: lines[lineIndex] || "",
      index: lineIndex,
    });
  }

  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + visibleLines < totalLines;

  const borderChar = "─";
  const topBorder = hasMoreAbove
    ? `─── ↑ ${scrollOffset} more ${borderChar.repeat(Math.max(0, width - 14 - scrollOffset.toString().length))}`
    : borderChar.repeat(width);
  const bottomBorder = hasMoreBelow
    ? `─── ↓ ${totalLines - scrollOffset - visibleLines} more ${borderChar.repeat(Math.max(0, width - 16 - (totalLines - scrollOffset - visibleLines).toString().length))}`
    : borderChar.repeat(width);

  return (
    <Box flexDirection="column">
      <Text>{topBorder.slice(0, width)}</Text>
      <Box flexDirection="column" paddingX={PADDING_X}>
        {displayedLines.map(({ text: line, index }) => (
          <Box key={index} height={1}>
            {index === cursorLineIndex ? (
              <>
                <Text>{line.slice(0, cursorCol)}</Text>
                <Text backgroundColor="white" color="black">
                  {line[cursorCol] || " "}
                </Text>
                <Text>{line.slice(cursorCol + 1)}</Text>
              </>
            ) : (
              <Text>{line || " "}</Text>
            )}
          </Box>
        ))}
        {disabled && (
          <Box>
            <Text dimColor>Agent is thinking...</Text>
          </Box>
        )}
      </Box>
      <Text>{bottomBorder.slice(0, width)}</Text>
    </Box>
  );
}

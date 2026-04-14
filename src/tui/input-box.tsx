import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface InputBoxProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
}

export function InputBox({ onSubmit, disabled }: InputBoxProps) {
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

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      {lines.map((line, i) => (
        <Box key={i}>
          {i === cursorLineIndex ? (
            <>
              <Text>{line.slice(0, cursorCol)}</Text>
              <Text backgroundColor="white" color="black">
                {line[cursorCol] || " "}
              </Text>
              <Text>{line.slice(cursorCol + 1)}</Text>
            </>
          ) : (
            <Text>{line}</Text>
          )}
        </Box>
      ))}
      {disabled && (
        <Box>
          <Text dimColor>Agent is thinking...</Text>
        </Box>
      )}
    </Box>
  );
}

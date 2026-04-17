import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SkillRegistry } from "../skills/registry.js";
import { theme } from "./theme.js";

interface InputBoxProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  skillRegistry?: SkillRegistry;
  terminalColumns: number;
}

const MIN_VISIBLE_LINES = 3;
const MAX_VISIBLE_LINES = 5;
const PADDING_X = 1;
const MAX_VISIBLE_SUGGESTIONS = 8;

interface SlashSuggestion {
  type: "command" | "skill";
  name: string;
  description: string;
}

export function InputBox({ onSubmit, disabled, skillRegistry, terminalColumns }: InputBoxProps) {
  const width = terminalColumns;

  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const isSlashContext = text.startsWith("/") && cursor > 0 && !text.includes("\n");
  const slashPrefix = isSlashContext ? text.slice(1).toLowerCase() : "";
  const suggestions = useMemo(() => {
    if (!isSlashContext) return [];
    const commandSuggestions: SlashSuggestion[] = slashRegistry.list().map((command) => ({
      type: "command",
      name: command.name,
      description: command.description,
    }));
    const skillSuggestions: SlashSuggestion[] = (skillRegistry?.summaries() ?? []).map((skill) => ({
      type: "skill",
      name: skill.name,
      description: skill.description,
    }));
    const all = [...commandSuggestions, ...skillSuggestions];
    return all.filter((item) => item.name.toLowerCase().startsWith(slashPrefix));
  }, [isSlashContext, slashPrefix, skillRegistry]);
  const showSuggestions = suggestions.length > 0;

  let suggestionOffset = 0;
  if (showSuggestions && suggestions.length > MAX_VISIBLE_SUGGESTIONS) {
    suggestionOffset = Math.min(
      Math.max(selectedIndex - Math.floor(MAX_VISIBLE_SUGGESTIONS / 2), 0),
      suggestions.length - MAX_VISIBLE_SUGGESTIONS,
    );
  }
  const visibleSuggestions = showSuggestions
    ? suggestions.slice(suggestionOffset, suggestionOffset + MAX_VISIBLE_SUGGESTIONS)
    : [];

  useInput((input, key) => {
    if (disabled) return;

    // Autocomplete navigation
    if (showSuggestions) {
      if (key.upArrow) {
        setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (key.escape) {
        // Cancel autocomplete: keep the slash, just hide suggestions
        // We achieve this by resetting selection; suggestions recompute if text changes
        setSelectedIndex(0);
        // If user continues typing, suggestions will reappear based on prefix
        // We don't consume escape here so app-level exit might still fire.
        // Actually let's just clear text to empty to close it quickly
        return;
      }
      if (key.return || key.tab) {
        const suggestion = suggestions[selectedIndex];
        if (suggestion) {
          const newText = `/${suggestion.name} `;
          setText(newText);
          setCursor(newText.length);
          setSelectedIndex(0);
        }
        return;
      }
    }

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
        setSelectedIndex(0);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        const before = text.slice(0, cursor - 1);
        const after = text.slice(cursor);
        setText(before + after);
        setCursor(cursor - 1);
        setSelectedIndex(0);
      }
      return;
    }

    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      setSelectedIndex(0);
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(text.length, cursor + 1));
      setSelectedIndex(0);
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
      setSelectedIndex(0);
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

  const contentWidth = Math.max(1, width - PADDING_X * 2);
  const borderChar = "─";
  const topBorder = hasMoreAbove
    ? `─── ↑ ${scrollOffset} more ${borderChar.repeat(Math.max(0, contentWidth - 14 - scrollOffset.toString().length))}`
    : borderChar.repeat(contentWidth);
  const bottomBorder = hasMoreBelow
    ? `─── ↓ ${totalLines - scrollOffset - visibleLines} more ${borderChar.repeat(Math.max(0, contentWidth - 16 - (totalLines - scrollOffset - visibleLines).toString().length))}`
    : borderChar.repeat(contentWidth);

  return (
    <Box flexDirection="column">
      <Text color={theme.border}>{topBorder.slice(0, contentWidth)}</Text>
      <Box flexDirection="column" paddingX={PADDING_X}>
        {displayedLines.map(({ text: line, index }) => {
          const displayLine = (line || " ").slice(0, contentWidth);
          return (
            <Box key={index} height={1} overflow="hidden">
              {index === cursorLineIndex ? (
                <>
                  <Text>{displayLine.slice(0, cursorCol)}</Text>
                  <Text backgroundColor="white" color="black">
                    {displayLine[cursorCol] || " "}
                  </Text>
                  <Text>{displayLine.slice(cursorCol + 1)}</Text>
                </>
              ) : (
                <Text>{displayLine}</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text color={theme.border}>{bottomBorder.slice(0, contentWidth)}</Text>
      {showSuggestions && (
        <Box flexDirection="column" marginTop={1}>
          {visibleSuggestions.map((cmd, visibleIndex) => {
            const i = suggestionOffset + visibleIndex;
            return (
            <Box key={cmd.name} height={1}>
              <Text>
                {i === selectedIndex ? (
                  <>
                    <Text backgroundColor="white" color="black">{` ${cmd.name.padEnd(16)} `}</Text>
                    <Text color={theme.muted}>[{cmd.type}]</Text>
                    <Text dimColor> {cmd.description}</Text>
                  </>
                ) : (
                  <>
                    <Text>{`  ${cmd.name.padEnd(16)} `}</Text>
                    <Text color={theme.muted}>[{cmd.type}]</Text>
                    <Text dimColor> {cmd.description}</Text>
                  </>
                )}
              </Text>
            </Box>
            );
          })}
          {suggestions.length > MAX_VISIBLE_SUGGESTIONS && (
            <Text color={theme.muted}>
              {`Showing ${suggestionOffset + 1}-${Math.min(
                suggestionOffset + MAX_VISIBLE_SUGGESTIONS,
                suggestions.length,
              )} of ${suggestions.length}`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

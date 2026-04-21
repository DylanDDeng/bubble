import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SkillRegistry } from "../skills/registry.js";
import { theme } from "./theme.js";
import { filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";

interface InputBoxProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  skillRegistry?: SkillRegistry;
  terminalColumns: number;
  cwd: string;
}

const MIN_VISIBLE_LINES = 1;
const MAX_VISIBLE_LINES = 5;
const PADDING_X = 1;
const PROMPT = "> ";
const MAX_VISIBLE_SUGGESTIONS = 8;

interface SlashSuggestion {
  type: "command" | "skill";
  name: string;
  description: string;
}

export function InputBox({ onSubmit, disabled, skillRegistry, terminalColumns, cwd }: InputBoxProps) {
  const width = terminalColumns;

  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projectFiles, setProjectFiles] = useState<string[] | null>(null);
  const loadingFilesRef = useRef(false);

  const isSlashContext = text.startsWith("/") && cursor > 0 && !text.includes("\n");
  const slashPrefix = isSlashContext ? text.slice(1).toLowerCase() : "";

  const atContext = useMemo(
    () => (isSlashContext ? null : findAtContext(text, cursor)),
    [text, cursor, isSlashContext],
  );

  useEffect(() => {
    if (!atContext || projectFiles !== null || loadingFilesRef.current) return;
    loadingFilesRef.current = true;
    listProjectFiles(cwd).then(
      (files) => setProjectFiles(files),
      () => setProjectFiles([]),
    );
  }, [atContext, cwd, projectFiles]);

  const slashSuggestions = useMemo(() => {
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

  const fileSuggestions = useMemo(() => {
    if (!atContext || !projectFiles) return [];
    return filterFileSuggestions(projectFiles, atContext.query, MAX_VISIBLE_SUGGESTIONS * 3);
  }, [atContext, projectFiles]);

  type SuggestionMode = "slash" | "file";
  const mode: SuggestionMode | null = slashSuggestions.length > 0
    ? "slash"
    : atContext
    ? "file"
    : null;
  const activeCount = mode === "slash" ? slashSuggestions.length : mode === "file" ? fileSuggestions.length : 0;
  const navigable = activeCount > 0;
  const showSuggestions = mode !== null;

  let suggestionOffset = 0;
  if (navigable && activeCount > MAX_VISIBLE_SUGGESTIONS) {
    suggestionOffset = Math.min(
      Math.max(selectedIndex - Math.floor(MAX_VISIBLE_SUGGESTIONS / 2), 0),
      activeCount - MAX_VISIBLE_SUGGESTIONS,
    );
  }

  const applyFileSuggestion = (selectedPath: string) => {
    if (!atContext) return;
    const before = text.slice(0, atContext.start);
    const after = text.slice(atContext.end);
    const insert = `@${selectedPath} `;
    const newText = before + insert + after;
    setText(newText);
    setCursor(before.length + insert.length);
    setSelectedIndex(0);
  };

  useInput((input, key) => {
    if (disabled) return;

    // Autocomplete navigation
    if (showSuggestions) {
      if (navigable && key.upArrow) {
        setSelectedIndex((i) => (i - 1 + activeCount) % activeCount);
        return;
      }
      if (navigable && key.downArrow) {
        setSelectedIndex((i) => (i + 1) % activeCount);
        return;
      }
      if (key.escape) {
        setSelectedIndex(0);
        return;
      }
      if (key.return || key.tab) {
        if (mode === "slash" && navigable) {
          const suggestion = slashSuggestions[selectedIndex];
          if (suggestion) {
            const newText = `/${suggestion.name} `;
            setText(newText);
            setCursor(newText.length);
            setSelectedIndex(0);
          }
          return;
        }
        if (mode === "file") {
          if (navigable) {
            const suggestion = fileSuggestions[selectedIndex];
            if (suggestion) applyFileSuggestion(suggestion.path);
          }
          // Swallow Enter/Tab even when no matches to avoid accidental submit.
          return;
        }
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
  const lineWidth = Math.max(1, contentWidth - PROMPT.length);
  const borderChar = "─";
  const topBorder = hasMoreAbove
    ? `─── ↑ ${scrollOffset} more ${borderChar.repeat(Math.max(0, contentWidth - 14 - scrollOffset.toString().length))}`
    : borderChar.repeat(contentWidth);
  const bottomBorder = hasMoreBelow
    ? `─── ↓ ${totalLines - scrollOffset - visibleLines} more ${borderChar.repeat(Math.max(0, contentWidth - 16 - (totalLines - scrollOffset - visibleLines).toString().length))}`
    : borderChar.repeat(contentWidth);

  return (
    <Box flexDirection="column">
      <Text color={theme.inputBorder}>{topBorder.slice(0, contentWidth)}</Text>
      <Box flexDirection="column" paddingX={PADDING_X}>
        {displayedLines.map(({ text: line, index }) => {
          const displayLine = (line || " ").slice(0, lineWidth);
          const isFirst = index === 0;
          return (
            <Box key={index} height={1} overflow="hidden">
              {isFirst ? (
                <Text color={theme.accent}>{PROMPT}</Text>
              ) : (
                <Text>{" ".repeat(PROMPT.length)}</Text>
              )}
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
      <Text color={theme.inputBorder}>{bottomBorder.slice(0, contentWidth)}</Text>
      {showSuggestions && mode === "slash" && (
        <Box flexDirection="column" marginTop={1}>
          {slashSuggestions
            .slice(suggestionOffset, suggestionOffset + MAX_VISIBLE_SUGGESTIONS)
            .map((cmd, visibleIndex) => {
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
          {slashSuggestions.length > MAX_VISIBLE_SUGGESTIONS && (
            <Text color={theme.muted}>
              {`Showing ${suggestionOffset + 1}-${Math.min(
                suggestionOffset + MAX_VISIBLE_SUGGESTIONS,
                slashSuggestions.length,
              )} of ${slashSuggestions.length}`}
            </Text>
          )}
        </Box>
      )}
      {showSuggestions && mode === "file" && (
        <Box flexDirection="column" marginTop={1}>
          {projectFiles === null && <Text dimColor>Loading project files…</Text>}
          {projectFiles !== null && fileSuggestions.length === 0 && (
            <Text dimColor>No files match "{atContext?.query ?? ""}"</Text>
          )}
          {fileSuggestions
            .slice(suggestionOffset, suggestionOffset + MAX_VISIBLE_SUGGESTIONS)
            .map((s, visibleIndex) => {
              const i = suggestionOffset + visibleIndex;
              const maxWidth = Math.max(10, Math.min(80, contentWidth - 2));
              const label = s.path.length > maxWidth ? "…" + s.path.slice(-(maxWidth - 1)) : s.path;
              return (
                <Box key={s.path} height={1}>
                  {i === selectedIndex ? (
                    <Text backgroundColor="white" color="black">{` ${label} `}</Text>
                  ) : (
                    <Text>{`  ${label}`}</Text>
                  )}
                </Box>
              );
            })}
          {fileSuggestions.length > MAX_VISIBLE_SUGGESTIONS && (
            <Text color={theme.muted}>
              {`Showing ${suggestionOffset + 1}-${Math.min(
                suggestionOffset + MAX_VISIBLE_SUGGESTIONS,
                fileSuggestions.length,
              )} of ${fileSuggestions.length}`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

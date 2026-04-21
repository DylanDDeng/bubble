import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useCursor, useInput, usePaste, type DOMElement } from "ink";
import stringWidth from "string-width";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SkillRegistry } from "../skills/registry.js";
import { theme } from "./theme.js";
import { filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";
import {
  ingestClipboardImage,
  ingestImagePath,
  isImageFilePath,
  isScreenshotTempPath,
  splitPastedPaths,
  type ImageAttachment,
} from "./image-paste.js";

export interface SubmitPayload {
  text: string;
  images: ImageAttachment[];
}

interface InputBoxProps {
  onSubmit: (payload: SubmitPayload) => void;
  onPasteNotice?: (notice: string) => void;
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

type VisualLine = {
  /** Segment of the source line that fits on this visual row. */
  text: string;
  /** Absolute offset in the source text where this visual row's characters start. */
  absStart: number;
  /** Index of the underlying logical (newline-separated) line. */
  logicalLineIndex: number;
};

// Break a logical line into segments that each fit within `maxWidth` display
// columns. Uses string-width so CJK and emoji wrap correctly; empty lines
// still produce one empty segment so cursors on blank lines render.
function wrapLineByWidth(line: string, maxWidth: number): string[] {
  if (line.length === 0) return [""];
  const out: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of line) {
    const w = stringWidth(ch);
    if (currentWidth + w > maxWidth && current.length > 0) {
      out.push(current);
      current = "";
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

function computeVisualLines(text: string, maxWidth: number): VisualLine[] {
  const logical = text.split("\n");
  const out: VisualLine[] = [];
  let abs = 0;
  for (let lIdx = 0; lIdx < logical.length; lIdx++) {
    const line = logical[lIdx];
    const segments = wrapLineByWidth(line, maxWidth);
    let offset = 0;
    for (const seg of segments) {
      out.push({ text: seg, absStart: abs + offset, logicalLineIndex: lIdx });
      offset += seg.length;
    }
    abs += line.length + 1; // consume the "\n"
  }
  return out;
}

// Map a source-text cursor index to its (visualRow, visualCol) coordinates.
function cursorToVisual(visualLines: VisualLine[], cursor: number): { row: number; col: number } {
  if (visualLines.length === 0) return { row: 0, col: 0 };
  let row = 0;
  for (let i = 0; i < visualLines.length; i++) {
    if (visualLines[i].absStart <= cursor) row = i;
    else break;
  }
  const vl = visualLines[row];
  const charOffset = Math.max(0, cursor - vl.absStart);
  return { row, col: stringWidth(vl.text.slice(0, charOffset)) };
}

// Map a (visualRow, visualCol) target back to a source-text cursor index.
// Used by up/down arrows to preserve the visual column when jumping rows.
function visualToCursor(visualLines: VisualLine[], row: number, col: number): number {
  if (visualLines.length === 0) return 0;
  const clamped = Math.max(0, Math.min(visualLines.length - 1, row));
  const vl = visualLines[clamped];
  let width = 0;
  let charOffset = 0;
  for (const ch of vl.text) {
    const w = stringWidth(ch);
    if (width + w > col) break;
    width += w;
    charOffset += ch.length;
  }
  return vl.absStart + charOffset;
}

interface SlashSuggestion {
  type: "command" | "skill";
  name: string;
  description: string;
}

export function InputBox({ onSubmit, onPasteNotice, disabled, skillRegistry, terminalColumns, cwd }: InputBoxProps) {
  const width = terminalColumns;

  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projectFiles, setProjectFiles] = useState<string[] | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const loadingFilesRef = useRef(false);
  // Paste and the keystrokes that follow can arrive inside the same stdin chunk
  // and dispatch within one discreteUpdates batch. If the Enter that a user
  // typed after a paste fires before React commits the paste-driven setState,
  // useInput's Enter branch reads stale `text` and submits without the paste.
  // This ref flips synchronously at paste-start and clears after the paste
  // commit has been flushed — useInput's Enter handler bails while it's set.
  const pastePendingRef = useRef(false);

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

  // Request a steady (non-blinking) block cursor via DECSCUSR while this
  // component is mounted. Terminals default to a blinking cursor, which is
  // distracting in an input that you'd glance away from. Restore the
  // terminal default on unmount so the user's shell isn't left with our
  // choice sticking around.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[2 q"); // steady block
    return () => {
      process.stdout.write("\x1b[0 q"); // reset to terminal default
    };
  }, []);

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

  const insertTextAtCursor = React.useCallback(
    (insertion: string) => {
      if (!insertion) return;
      setText((prev) => {
        const c = cursor;
        const before = prev.slice(0, c);
        const after = prev.slice(c);
        return before + insertion + after;
      });
      setCursor((c) => c + insertion.length);
    },
    [cursor],
  );

  const addAttachment = React.useCallback((att: ImageAttachment) => {
    setAttachments((prev) => [...prev, att]);
  }, []);

  const notice = React.useCallback(
    (msg: string) => {
      onPasteNotice?.(msg);
    },
    [onPasteNotice],
  );

  // Empty paste is the common signal that the clipboard holds an image and the
  // terminal has nothing textual to deliver. Probe the clipboard; if it yields
  // an image, treat the paste as an image attachment. macOS only — Linux/Win
  // terminals don't reliably emit empty pastes on image-only clipboards.
  const tryClipboardImage = React.useCallback(async () => {
    const { attachment, error } = await ingestClipboardImage();
    if (attachment) {
      addAttachment(attachment);
      return true;
    }
    if (error && error !== "clipboard has no image") {
      notice(`image paste failed: ${error}`);
    }
    return false;
  }, [addAttachment, notice]);

  usePaste((pasted) => {
    pastePendingRef.current = true;
    // Clear the ref after React has committed the paste-driven setState.
    // setTimeout with 0 runs after the current discreteUpdates batch flushes.
    const clearPending = () => {
      setTimeout(() => {
        pastePendingRef.current = false;
      }, 0);
    };

    // Strip orphaned focus-event tails that can appear if focus reporting
    // splits across the paste boundary.
    const clean = pasted.replace(/\x1b\[I$/, "").replace(/\x1b\[O$/, "");

    // Empty paste on macOS usually means "Cmd+V with an image on the clipboard".
    if (clean.length === 0) {
      if (process.platform === "darwin") {
        void tryClipboardImage().finally(clearPending);
      } else {
        clearPending();
      }
      return;
    }

    // Look for image paths inside the paste (drag-and-drop from Finder/
    // Nautilus/Explorer). Multi-selection can arrive newline- or
    // space-separated.
    const tokens = splitPastedPaths(clean);
    const imageTokens = tokens.filter(isImageFilePath);

    if (imageTokens.length === 0) {
      // Plain text paste — insert into the input at the cursor.
      insertTextAtCursor(clean);
      clearPending();
      return;
    }

    const handle = async () => {
      const results = await Promise.all(imageTokens.map((t) => ingestImagePath(t)));
      const successful: ImageAttachment[] = [];
      const errors: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const { attachment, error } = results[i]!;
        if (attachment) {
          successful.push(attachment);
        } else if (error) {
          errors.push(`${imageTokens[i]}: ${error}`);
        }
      }

      // macOS screenshot shortcut writes a TemporaryItems path into the
      // clipboard but the file may already be gone by the time we read it.
      // Fall back to the clipboard image when that happens.
      if (
        successful.length === 0 &&
        process.platform === "darwin" &&
        imageTokens.some(isScreenshotTempPath)
      ) {
        const clipOk = await tryClipboardImage();
        if (clipOk) return;
      }

      for (const att of successful) addAttachment(att);

      const nonImageLines = tokens.filter((t) => !isImageFilePath(t));
      if (successful.length > 0 && nonImageLines.length > 0) {
        insertTextAtCursor(nonImageLines.join("\n"));
      } else if (successful.length === 0) {
        // None resolved — fall back to treating the paste as text.
        insertTextAtCursor(clean);
      }

      for (const err of errors) notice(err);
    };

    void handle().finally(clearPending);
  });

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
        // A paste is still mid-flight — dropping this Enter avoids submitting
        // an input state that doesn't yet include the paste.
        if (pastePendingRef.current) return;
        if (text.trim().length === 0 && attachments.length === 0) return;
        onSubmit({ text, images: attachments });
        setText("");
        setCursor(0);
        setSelectedIndex(0);
        setAttachments([]);
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
      } else if (attachments.length > 0) {
        // Backspace at position 0 drops the most recent attachment so users
        // can undo a misfired paste without submitting the message.
        setAttachments((prev) => prev.slice(0, -1));
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
      if (cursorVisualRow > 0) {
        setCursor(visualToCursor(visualLines, cursorVisualRow - 1, cursorVisualCol));
      }
      return;
    }
    if (key.downArrow) {
      if (cursorVisualRow < visualLines.length - 1) {
        setCursor(visualToCursor(visualLines, cursorVisualRow + 1, cursorVisualCol));
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

  // Anchor the cursor to the content Box (which holds the visual rows). Its
  // absolute yoga top lands exactly on the first visible visual row, so the
  // y offset to the cursor's row is just (cursorVisualRow - scrollOffset) —
  // no fiddly accounting for borders or the optional attachments row above.
  const contentAreaRef = useRef<DOMElement | null>(null);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const { setCursorPosition } = useCursor();

  const contentWidth = Math.max(1, width - PADDING_X * 2);
  const lineWidth = Math.max(1, contentWidth - PROMPT.length);

  const visualLines = useMemo(
    () => computeVisualLines(text, lineWidth),
    [text, lineWidth],
  );
  const { row: cursorVisualRow, col: cursorVisualCol } = cursorToVisual(visualLines, cursor);

  const totalLines = Math.max(visualLines.length, 1);
  const visibleLines = Math.min(Math.max(totalLines, MIN_VISIBLE_LINES), MAX_VISIBLE_LINES);

  let scrollOffset = 0;
  if (totalLines > visibleLines) {
    scrollOffset = Math.min(
      Math.max(cursorVisualRow - Math.floor(visibleLines / 2), 0),
      totalLines - visibleLines,
    );
  }

  const displayedLines: { text: string; visualIdx: number }[] = [];
  for (let i = 0; i < visibleLines; i++) {
    const visualIdx = scrollOffset + i;
    const vl = visualLines[visualIdx];
    displayedLines.push({
      text: vl ? vl.text : "",
      visualIdx,
    });
  }

  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + visibleLines < totalLines;

  // Measure after yoga runs (useLayoutEffect fires after Ink's resetAfterCommit
  // calls onComputeLayout). Push the new position into useCursor's ref and bump
  // `cursorTick` to force one more render so useCursor's useInsertionEffect
  // sees the fresh value and Ink emits a cursor-only update.
  const [cursorTick, setCursorTick] = useState(0);
  useLayoutEffect(() => {
    let node: DOMElement | undefined = contentAreaRef.current ?? undefined;
    if (!node?.yogaNode) {
      setCursorPosition(undefined);
      return;
    }
    let left = 0;
    let top = 0;
    while (node?.yogaNode) {
      const layout = node.yogaNode.getComputedLayout();
      left += layout.left;
      top += layout.top;
      node = node.parentNode;
    }
    const rowWithin = cursorVisualRow - scrollOffset;
    const colWithin = PADDING_X /* content box's own paddingX */ + PROMPT.length + cursorVisualCol;
    const next = { x: left + colWithin, y: top + rowWithin };
    const prev = lastCursorRef.current;
    if (!prev || prev.x !== next.x || prev.y !== next.y) {
      lastCursorRef.current = next;
      setCursorPosition(next);
      setCursorTick((t) => t + 1);
    }
  });
  // Reference cursorTick so the effect re-runs on the forced render pass.
  void cursorTick;
  const borderChar = "─";
  const topBorder = hasMoreAbove
    ? `─── ↑ ${scrollOffset} more ${borderChar.repeat(Math.max(0, contentWidth - 14 - scrollOffset.toString().length))}`
    : borderChar.repeat(contentWidth);
  const bottomBorder = hasMoreBelow
    ? `─── ↓ ${totalLines - scrollOffset - visibleLines} more ${borderChar.repeat(Math.max(0, contentWidth - 16 - (totalLines - scrollOffset - visibleLines).toString().length))}`
    : borderChar.repeat(contentWidth);

  return (
    <Box flexDirection="column">
      {attachments.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap" paddingX={PADDING_X} marginBottom={0}>
          {attachments.map((att, i) => {
            const label = att.filename || "clipboard";
            const kb = Math.max(1, Math.round(att.bytes / 1024));
            return (
              <Box key={i} marginRight={1}>
                <Text color={theme.accent}>{`[img${attachments.length > 1 ? ` ${i + 1}` : ""}: ${label} · ${kb}KB]`}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Text color={theme.inputBorder}>{topBorder.slice(0, contentWidth)}</Text>
      <Box flexDirection="column" paddingX={PADDING_X} ref={contentAreaRef}>
        {displayedLines.map(({ text: line, visualIdx }) => {
          const displayLine = line.length === 0 ? " " : line;
          const isFirst = visualIdx === 0;
          return (
            <Box key={visualIdx} height={1} overflow="hidden">
              {isFirst ? (
                <Text color={theme.accent}>{PROMPT}</Text>
              ) : (
                <Text>{" ".repeat(PROMPT.length)}</Text>
              )}
              <Text>{displayLine}</Text>
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

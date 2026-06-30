import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useCursor, useInput, usePaste, useStdout, type DOMElement } from "ink";
import { visualWidth, graphemeWidth } from "./width.js";
import { appendFileSync } from "node:fs";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SkillRegistry } from "../skills/registry.js";
import { useTheme } from "./theme.js";
import { filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";
import {
  bareImageFilenameFromPaste,
  ingestClipboardImage,
  ingestImagePath,
  isImageFilePath,
  isScreenshotTempPath,
  splitPastedPaths,
  type ImageAttachment,
} from "./image-paste.js";
import {
  appendHistoryEntry,
  loadHistoryEntriesSync,
  pushHistoryEntry,
  stepHistory,
  type HistoryEntry,
  type HistoryScope,
} from "./input-history.js";
import { isKeyReleaseEvent } from "./key-events.js";
import { stripTerminalMouseSequences } from "./terminal-mouse.js";
import { submitPayloadFingerprint } from "./submit-dedupe.js";
export {
  createPastedContentMarker,
  expandPastedContentMarkers,
  shouldCollapsePastedContent,
  type PastedContentReference,
} from "../tui/paste-placeholder.js";
import {
  createPastedContentMarker,
  expandPastedContentMarkers,
  shouldCollapsePastedContent,
  type PastedContentReference,
} from "../tui/paste-placeholder.js";
import { imageDisplayLabel, stripInlineImageLabels } from "../tui/image-display.js";

export interface SubmitPayload {
  /** Fully-expanded text sent to the agent. */
  text: string;
  /** Text shown in the composer/transcript when it differs from the real text. */
  displayText?: string;
  images: ImageAttachment[];
  /** First UI-only [Image #N] label reserved for this submitted payload. */
  imageDisplayStart?: number;
}

interface InputBoxProps {
  onSubmit: (payload: SubmitPayload) => void;
  /**
   * When set (agent running), Tab queues the composer content for the next
   * turn instead of its idle-time behavior.
   */
  onQueue?: (payload: SubmitPayload) => void;
  onPasteNotice?: (notice: string) => void;
  disabled?: boolean;
  /**
   * Called when Down is pressed at the bottom edge with nothing newer in
   * history — the parent uses this to move focus out of the composer (e.g. into
   * the subagent entry), matching Claude Code's ↓-to-focus-the-task-panel.
   */
  onArrowDownAtBottom?: () => void;
  cursorResetEpoch?: number;
  draftText?: string;
  draftEpoch?: number;
  onDraftApplied?: () => void;
  skillRegistry?: SkillRegistry;
  localSlashCommands?: Array<{ name: string; description: string }>;
  terminalColumns: number;
  cwd: string;
  sessionFile?: string;
  nextImageLabelStart?: number;
}

const MIN_VISIBLE_LINES = 3;
const MAX_VISIBLE_LINES = 6;
const PADDING_X = 1;
const PROMPT = " > ";
const MAX_VISIBLE_SUGGESTIONS = 8;

export function needsCursorRowCompensation(
  nextOutputHeight: number,
  viewportRows: number,
  previousOutputHeight: number | null,
): boolean {
  const hadPreviousFrame = previousOutputHeight !== null && previousOutputHeight > 0;
  const isFullscreen = nextOutputHeight >= viewportRows;
  const wasFullscreen = hadPreviousFrame && previousOutputHeight >= viewportRows;
  const wasOverflowing = hadPreviousFrame && previousOutputHeight > viewportRows;
  const isOverflowing = nextOutputHeight > viewportRows;
  const isLeavingFullscreen = wasFullscreen && nextOutputHeight < viewportRows;

  // Ink omits the trailing newline in two cases that matter for cursor math:
  // the normal fullscreen frame, and the clear/sync frame used when leaving an
  // overflowing viewport. buildCursorSuffix still assumes the cursor starts one
  // line below the output, so pass y+1 in those cases.
  return isFullscreen || wasOverflowing || (isOverflowing && hadPreviousFrame) || isLeavingFullscreen;
}

export function resolveCursorRowCompensation(input: {
  sameRenderedFrame: boolean;
  previousRowCompensation: number;
  nextOutputHeight: number;
  viewportRows: number;
  previousOutputHeight: number | null;
}): number {
  if (input.sameRenderedFrame) return input.previousRowCompensation;
  return needsCursorRowCompensation(
    input.nextOutputHeight,
    input.viewportRows,
    input.previousOutputHeight,
  ) ? 1 : 0;
}

export function isCtrlCInput(input: string, key: { ctrl?: boolean }): boolean {
  return input === "\x03" || (key.ctrl === true && input.toLowerCase() === "c");
}

export function shouldUseLineComposerFrame(_background: string): boolean {
  return true;
}

export function composerSurfaceBackground(lineFrame: boolean, background: string, inputBg: string): string {
  return lineFrame ? background : inputBg;
}

export function shouldUseHardwareComposerCursor(env: Record<string, string | undefined> = process.env): boolean {
  return env.BUBBLE_HARDWARE_CURSOR === "1";
}

export function composerVerticalArrowDirection(key: {
  upArrow?: boolean;
  downArrow?: boolean;
  eventType?: string;
}): "up" | "down" | undefined {
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  return undefined;
}

export function resolveSoftwareCursorCellStyle(input: {
  visible: boolean;
  cursorBackground: string;
  cursorForeground: string;
  textColor: string;
  rowBackground?: string;
}): { backgroundColor?: string; color: string } {
  if (input.visible) {
    return {
      backgroundColor: input.cursorBackground,
      color: input.cursorForeground,
    };
  }
  return {
    backgroundColor: input.rowBackground,
    color: input.textColor,
  };
}

/**
 * Split a composer line around the cursor so the cell under it can render as
 * an inverse-video software cursor. The visible cursor must not depend on the
 * real terminal cursor: Ink only re-arms its one-shot cursor escape when the
 * component owning useCursor re-commits, so frames produced by other
 * components' local state (the waiting spinner, viewport scrolling) hide the
 * hardware cursor for most of an agent run. Drawing and blinking the cell
 * ourselves keeps it visible while preserving normal typing feedback; the real
 * cursor is still positioned for IME anchoring.
 */
export function splitLineAtCursor(
  lineText: string,
  charOffset: number,
): { before: string; at: string; after: string } {
  const offset = Math.max(0, Math.min(charOffset, lineText.length));
  if (offset >= lineText.length) {
    return { before: lineText, at: " ", after: "" };
  }
  const codePoint = lineText.codePointAt(offset)!;
  const length = codePoint > 0xffff ? 2 : 1;
  return {
    before: lineText.slice(0, offset),
    at: lineText.slice(offset, offset + length),
    after: lineText.slice(offset + length),
  };
}

type VisualLine = {
  /** Segment of the source line that fits on this visual row. */
  text: string;
  /** Absolute offset in the source text where this visual row's characters start. */
  absStart: number;
  /** Index of the underlying logical (newline-separated) line. */
  logicalLineIndex: number;
};

// Break a logical line into segments that each fit within `maxWidth` display
// columns. Uses the shared terminal-aware width (./width.js) so CJK, emoji and
// ambiguous-width chars wrap exactly as the terminal renders them; empty lines
// still produce one empty segment so cursors on blank lines render.
function wrapLineByWidth(line: string, maxWidth: number): string[] {
  if (line.length === 0) return [""];
  const out: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of line) {
    const w = graphemeWidth(ch);
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
  return { row, col: visualWidth(vl.text.slice(0, charOffset)) };
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
    const w = graphemeWidth(ch);
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

export interface TextHighlightRange {
  start: number;
  end: number;
}

export type ComposerTextSegmentKind = "normal" | "command" | "cursor";

export interface ComposerTextSegment {
  kind: ComposerTextSegmentKind;
  text: string;
}

export function resolveSlashCommandHighlightRange(
  input: string,
  commandNames: Iterable<string>,
): TextHighlightRange | null {
  if (!input.startsWith("/")) return null;
  const match = /^\/([^\s]+)/.exec(input);
  if (!match) return null;
  const commandName = match[1]?.toLowerCase();
  if (!commandName) return null;
  for (const name of commandNames) {
    if (name.toLowerCase() === commandName) {
      return { start: 0, end: match[0].length };
    }
  }
  return null;
}

function splitHighlightedText(
  text: string,
  absStart: number,
  highlight: TextHighlightRange | null,
): ComposerTextSegment[] {
  if (!text) return [];
  if (!highlight) return [{ kind: "normal", text }];
  const start = Math.max(0, highlight.start - absStart);
  const end = Math.min(text.length, highlight.end - absStart);
  if (start >= end) return [{ kind: "normal", text }];
  const segments: ComposerTextSegment[] = [];
  if (start > 0) segments.push({ kind: "normal", text: text.slice(0, start) });
  segments.push({ kind: "command", text: text.slice(start, end) });
  if (end < text.length) segments.push({ kind: "normal", text: text.slice(end) });
  return segments;
}

export function splitComposerTextSegments(input: {
  text: string;
  absStart: number;
  highlight: TextHighlightRange | null;
  cursorOffset?: number;
}): ComposerTextSegment[] {
  if (input.cursorOffset === undefined) {
    return splitHighlightedText(input.text, input.absStart, input.highlight);
  }

  const cursorOffset = Math.max(0, Math.min(input.text.length, input.cursorOffset));
  const cursorSegments = splitLineAtCursor(input.text, cursorOffset);
  const cursorConsumesSource = cursorOffset < input.text.length;
  return [
    ...splitHighlightedText(cursorSegments.before, input.absStart, input.highlight),
    { kind: "cursor" as const, text: cursorSegments.at },
    ...splitHighlightedText(
      cursorSegments.after,
      input.absStart + cursorOffset + (cursorConsumesSource ? cursorSegments.at.length : 0),
      input.highlight,
    ),
  ];
}

export function shouldSubmitExactSlashSuggestion(input: string, suggestionName?: string): boolean {
  if (!suggestionName) return false;
  return input.trim() === `/${suggestionName}`;
}

export function resolveSlashEnterAction(
  input: string,
  suggestions: Array<{ name: string }>,
  selectedIndex: number,
): { kind: "submit" } | { kind: "complete"; text: string } | { kind: "none" } {
  if (suggestions.some((item) => shouldSubmitExactSlashSuggestion(input, item.name))) {
    return { kind: "submit" };
  }
  const suggestion = suggestions[selectedIndex];
  return suggestion ? { kind: "complete", text: `/${suggestion.name} ` } : { kind: "none" };
}

export type InkEnterIntent = "none" | "newline" | "submit";

const KITTY_RETURN_PRIVATE_USE = String.fromCodePoint(57345);

export function isInkModifiedEnterInput(input: string): boolean {
  const normalized = input.startsWith("\x1b") ? input.slice(1) : input;
  return normalized === KITTY_RETURN_PRIVATE_USE
    || /^\[(?:13|57345)(?::\d+){0,2};[2-9]\d*(?::[12])?u$/.test(normalized)
    || /^\[27;[2-9]\d*(?::[12])?;(?:13|57345)~$/.test(normalized);
}

export function resolveInkEnterIntent(
  input: string,
  key: { return?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean; eventType?: string },
): InkEnterIntent {
  if (key.eventType === "release") return "none";
  const hasReturnInput = !!input && /[\r\n]/.test(input);
  if (isInkModifiedEnterInput(input)) return "newline";
  const isEnter = hasReturnInput || !!key.return;
  if (!isEnter) return "none";
  if (key.shift || key.ctrl || key.meta) return "newline";
  return "submit";
}

export function insertNewlineAtCursor(text: string, cursor: number) {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  return {
    text: `${text.slice(0, clampedCursor)}\n${text.slice(clampedCursor)}`,
    cursor: clampedCursor + 1,
  };
}

export function previousWordBoundary(text: string, cursor: number): number {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  if (clampedCursor === 0) return 0;
  let index = clampedCursor - 1;
  while (index > 0 && /\s/.test(text[index]!)) index--;
  while (index > 0 && !/\s/.test(text[index - 1]!)) index--;
  return index;
}

export function nextWordBoundary(text: string, cursor: number): number {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  if (clampedCursor === text.length) return text.length;
  let index = clampedCursor;
  while (index < text.length && /\s/.test(text[index]!)) index++;
  while (index < text.length && !/\s/.test(text[index]!)) index++;
  return index;
}

export function lineStartBoundary(text: string, cursor: number): number {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  return text.lastIndexOf("\n", clampedCursor - 1) + 1;
}

export function lineEndBoundary(text: string, cursor: number): number {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  const lineEnd = text.indexOf("\n", clampedCursor);
  return lineEnd === -1 ? text.length : lineEnd;
}

export function deleteToLineStart(text: string, cursor: number): { text: string; cursor: number } {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  const lineStart = lineStartBoundary(text, clampedCursor);
  return {
    text: text.slice(0, lineStart) + text.slice(clampedCursor),
    cursor: lineStart,
  };
}

export function deleteToLineEnd(text: string, cursor: number): { text: string; cursor: number } {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  const lineEnd = lineEndBoundary(text, clampedCursor);
  return {
    text: text.slice(0, clampedCursor) + text.slice(lineEnd),
    cursor: clampedCursor,
  };
}

export function deleteAtCursor(text: string, cursor: number): { text: string; cursor: number } {
  const clampedCursor = Math.max(0, Math.min(text.length, cursor));
  if (clampedCursor >= text.length) return { text, cursor: clampedCursor };
  return {
    text: text.slice(0, clampedCursor) + text.slice(clampedCursor + 1),
    cursor: clampedCursor,
  };
}

export type ComposerEditAction =
  | "word-left"
  | "word-right"
  | "line-start"
  | "line-end"
  | "delete-line-start"
  | "delete-line-end";

export function resolveComposerEditAction(
  input: string,
  key: {
    ctrl?: boolean;
    meta?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    home?: boolean;
    end?: boolean;
  },
): ComposerEditAction | null {
  if (key.home) return "line-start";
  if (key.end) return "line-end";

  const wordModifier = key.ctrl || key.meta;
  if (wordModifier && key.leftArrow) return "word-left";
  if (wordModifier && key.rightArrow) return "word-right";

  const lowerInput = input.toLowerCase();
  if ((key.ctrl && lowerInput === "a") || input === "\x01") return "line-start";
  if ((key.ctrl && lowerInput === "e") || input === "\x05") return "line-end";
  if ((key.ctrl && lowerInput === "u") || input === "\x15") return "delete-line-start";
  if ((key.ctrl && lowerInput === "k") || input === "\x0b") return "delete-line-end";

  return null;
}

export function InputBox({
  onSubmit,
  onQueue,
  onPasteNotice,
  disabled,
  onArrowDownAtBottom,
  cursorResetEpoch = 0,
  draftText,
  draftEpoch = 0,
  onDraftApplied,
  skillRegistry,
  localSlashCommands = [],
  terminalColumns,
  cwd,
  sessionFile,
  nextImageLabelStart = 1,
}: InputBoxProps) {
  const theme = useTheme();
  const width = terminalColumns;
  const historyScope = useMemo<HistoryScope>(() => ({ sessionFile, cwd }), [sessionFile, cwd]);
  const hardwareCursorEnabled = shouldUseHardwareComposerCursor();

  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [softwareCursorVisible, setSoftwareCursorVisible] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projectFiles, setProjectFiles] = useState<string[] | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [imageLabelStartOverride, setImageLabelStartOverride] = useState<number | null>(null);
  const [pastedContentRefs, setPastedContentRefs] = useState<PastedContentReference[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistoryEntriesSync({ scope: historyScope }));
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraftRef = useRef<string | HistoryEntry>("");
  const historyScopeRef = useRef(historyScope);
  const submittedPayloadFingerprintRef = useRef<string | null>(null);
  const loadingFilesRef = useRef(false);
  const nextPastedContentIndexRef = useRef(1);
  // Kept equal to attachments.length so a synchronous multi-image paste loop
  // assigns each image its correct (distinct) inline label index.
  const attachmentCountRef = useRef(0);
  // Paste and the keystrokes that follow can arrive inside the same stdin chunk
  // and dispatch within one discreteUpdates batch. If the Enter that a user
  // typed after a paste fires before React commits the paste-driven setState,
  // useInput's Enter branch reads stale `text` and submits without the paste.
  // This ref flips synchronously at paste-start and clears after the paste
  // commit has been flushed — useInput's Enter handler bails while it's set.
  const pastePendingRef = useRef(false);

  historyScopeRef.current = historyScope;

  const ensureImageLabelStart = React.useCallback(() => {
    setImageLabelStartOverride((current) => current ?? nextImageLabelStart);
  }, [nextImageLabelStart]);

  useEffect(() => {
    setHistory(loadHistoryEntriesSync({ scope: historyScope }));
    setHistoryIndex(null);
    setImageLabelStartOverride(null);
    historyDraftRef.current = "";
  }, [historyScope]);

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

  // The rendered inverse-video cell below is the visible cursor. Keep Ink's
  // terminal cursor hidden by default so it can't race the software cursor; the
  // hardware cursor can be enabled for IME diagnostics with BUBBLE_HARDWARE_CURSOR=1.
  useEffect(() => {
    if (!hardwareCursorEnabled) return;
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[1 q"); // blinking block
    return () => {
      process.stdout.write("\x1b[0 q"); // reset to terminal default
    };
  }, [hardwareCursorEnabled]);

  const slashSuggestions = useMemo(() => {
    if (!isSlashContext) return [];
    const commands = new Map<string, { name: string; description: string }>();
    for (const command of localSlashCommands) {
      commands.set(command.name, command);
    }
    for (const command of slashRegistry.list()) {
      if (!commands.has(command.name)) commands.set(command.name, command);
    }
    const commandSuggestions: SlashSuggestion[] = [...commands.values()].map((command) => ({
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
  }, [isSlashContext, slashPrefix, skillRegistry, localSlashCommands]);

  const knownSlashCommandNames = useMemo(() => {
    const names = new Set<string>();
    for (const command of localSlashCommands) names.add(command.name);
    for (const command of slashRegistry.list()) names.add(command.name);
    for (const skill of skillRegistry?.summaries() ?? []) names.add(skill.name);
    return names;
  }, [skillRegistry, localSlashCommands]);

  const slashCommandHighlight = useMemo(
    () => resolveSlashCommandHighlightRange(text, knownSlashCommandNames),
    [text, knownSlashCommandNames],
  );

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
    const base = imageLabelStartOverride ?? nextImageLabelStart;
    const index = attachmentCountRef.current;
    attachmentCountRef.current += 1;
    // Place the image label inline at the cursor so the reference appears where
    // it was pasted (not forced to the start), and moves with later edits. It is
    // stripped from the text on submit so the model still receives clean text.
    insertTextAtCursor(`${imageDisplayLabel(base + index)} `);
    ensureImageLabelStart();
    setAttachments((prev) => [...prev, att]);
  }, [ensureImageLabelStart, insertTextAtCursor, imageLabelStartOverride, nextImageLabelStart]);

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
    // splits across the paste boundary. Bracketed paste also delivers line
    // breaks as bare CR on many terminals; left as-is, those CRs survive into
    // the rendered Text and the terminal interprets them as "return to column
    // 0", visually overwriting earlier characters even though the underlying
    // state still holds the full paste.
    const clean = pasted
      .replace(/\x1b\[I$/, "")
      .replace(/\x1b\[O$/, "")
      .replace(/\r\n?/g, "\n");

    // Empty paste on macOS usually means "Cmd+V with an image on the clipboard".
    if (clean.length === 0) {
      if (process.platform === "darwin") {
        void tryClipboardImage().finally(clearPending);
      } else {
        clearPending();
      }
      return;
    }

    // Copying an image file in Finder pastes only the file's NAME while the
    // real bits stay on the system clipboard — attach from there. If the
    // clipboard turns out to hold no image, it was just text: insert it
    // quietly.
    const bareName = bareImageFilenameFromPaste(clean);
    if (bareName && process.platform === "darwin") {
      void tryClipboardImage()
        .then((attached) => {
          if (!attached) insertTextAtCursor(clean);
        })
        .finally(clearPending);
      return;
    }

    // Look for image paths inside the paste (drag-and-drop from Finder/
    // Nautilus/Explorer). Multi-selection can arrive newline- or
    // space-separated.
    const tokens = splitPastedPaths(clean);
    const imageTokens = tokens.filter(isImageFilePath);

    if (imageTokens.length === 0) {
      // Plain text paste — insert into the input at the cursor.
      if (shouldCollapsePastedContent(clean)) {
        const marker = createPastedContentMarker(clean, nextPastedContentIndexRef.current++);
        setPastedContentRefs((prev) => [...prev, { marker, content: clean }]);
        insertTextAtCursor(marker);
      } else {
        insertTextAtCursor(clean);
      }
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
  }, { isActive: !disabled });

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

  const submitInput = (submittedText: string, target: "submit" | "queue" = "submit") => {
    const labelStartForSubmit = imageLabelStartOverride ?? nextImageLabelStart;
    const inlineLabels = attachments.map((_, index) => imageDisplayLabel(labelStartForSubmit + index));
    // Text-paste markers expand to their content (not replayable); image labels
    // are a composer-only affordance stripped here (replayable via attachments).
    const pasteExpanded = expandPastedContentMarkers(submittedText, pastedContentRefs);
    const expandedText = stripInlineImageLabels(pasteExpanded, inlineLabels);
    if (expandedText.trim().length === 0 && attachments.length === 0) return;
    const deliver = target === "queue" && onQueue ? onQueue : onSubmit;
    const payload = {
      // The pasted-content marker is a composer-only affordance. Submit the
      // fully-expanded text so the transcript shows what was actually sent —
      // the agent already receives the expanded text — rather than the marker.
      // `text` (model input) has image labels stripped; `displayText` keeps them
      // inline at their paste position so the transcript shows the image there.
      text: expandedText,
      ...(inlineLabels.length > 0 && pasteExpanded !== expandedText ? { displayText: pasteExpanded } : {}),
      images: attachments,
      imageDisplayStart: attachments.length > 0 ? (imageLabelStartOverride ?? nextImageLabelStart) : undefined,
    };
    const fingerprint = submitPayloadFingerprint(payload);
    if (submittedPayloadFingerprintRef.current === fingerprint) return;
    submittedPayloadFingerprintRef.current = fingerprint;
    deliver(payload);
    // A collapsed text-paste marker cannot be safely replayed once its
    // in-memory reference is gone; skip those. Image-label stripping is fine to
    // replay (the attachments are stored on the history entry).
    if (pasteExpanded === submittedText && (expandedText.trim().length > 0 || attachments.length > 0)) {
      const historyEntry: HistoryEntry = {
        text: expandedText,
        images: attachments,
        ...(attachments.length > 0 ? { imageDisplayStart: imageLabelStartOverride ?? nextImageLabelStart } : {}),
      };
      setHistory((current) => {
        const nextHistory = pushHistoryEntry(current, historyEntry);
        if (nextHistory !== current) {
          appendHistoryEntry(historyEntry, { scope: historyScopeRef.current });
        }
        return nextHistory;
      });
    }
    setText("");
    setCursor(0);
    setSelectedIndex(0);
    setAttachments([]);
    attachmentCountRef.current = 0;
    setImageLabelStartOverride(null);
    setPastedContentRefs([]);
    nextPastedContentIndexRef.current = 1;
    setHistoryIndex(null);
    historyDraftRef.current = "";
  };

  const applySlashEnterAction = (submittedText: string) => {
    const action = resolveSlashEnterAction(submittedText, slashSuggestions, selectedIndex);
    if (action.kind === "submit") {
      submitInput(submittedText);
      return true;
    }
    if (action.kind === "complete") {
      setText(action.text);
      setCursor(action.text.length);
      setSelectedIndex(0);
      return true;
    }
    return false;
  };

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    const strippedInput = stripTerminalMouseSequences(input);
    if (strippedInput !== input && !strippedInput) {
      return;
    }
    input = strippedInput;
    if (disabled) return;
    if (isCtrlCInput(input, key)) return;
    if (process.env.BUBBLE_KEY_DEBUG) {
      try {
        appendFileSync(
          "/tmp/bubble-key.log",
          JSON.stringify({
            t: new Date().toISOString(),
            input,
            inputCodes: [...input].map((ch) => ch.codePointAt(0)),
            key,
          }) + "\n",
        );
      } catch {}
    }

    const enterIntent = resolveInkEnterIntent(input, key);

    if (enterIntent === "newline") {
      const next = insertNewlineAtCursor(text, cursor);
      setText(next.text);
      setCursor(next.cursor);
      setSelectedIndex(0);
      return;
    }

    if (enterIntent === "submit" && input && /[\r\n]/.test(input)) {
      const beforeReturn = input.split(/[\r\n]/)[0] ?? "";
      const nextText = text.slice(0, cursor) + beforeReturn + text.slice(cursor);
      if (showSuggestions) {
        if (mode === "slash" && navigable && applySlashEnterAction(nextText)) {
          return;
        }
        if (mode === "file") {
          if (navigable) {
            const suggestion = fileSuggestions[selectedIndex];
            if (suggestion) applyFileSuggestion(suggestion.path);
          }
          return;
        }
      }
      submitInput(nextText);
      return;
    }

    const composerArrowDirection = composerVerticalArrowDirection(key);

    // Autocomplete navigation
    if (showSuggestions) {
      if (navigable && composerArrowDirection === "up") {
        setSelectedIndex((i) => (i - 1 + activeCount) % activeCount);
        return;
      }
      if (navigable && composerArrowDirection === "down") {
        setSelectedIndex((i) => (i + 1) % activeCount);
        return;
      }
      if (key.escape) {
        setSelectedIndex(0);
        return;
      }
      if (key.return || key.tab) {
        if (mode === "slash" && navigable) {
          if (key.return) applySlashEnterAction(text);
          if (key.tab) {
            const suggestion = slashSuggestions[selectedIndex];
            if (suggestion) {
              const newText = `/${suggestion.name} `;
              setText(newText);
              setCursor(newText.length);
              setSelectedIndex(0);
            }
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

    // While the agent runs, Tab queues the composer content for the next
    // turn (Enter steers — handled by the app-level submit routing).
    if (key.tab && !key.shift && onQueue && !showSuggestions) {
      if (pastePendingRef.current) return;
      submitInput(text, "queue");
      return;
    }

    if (enterIntent === "submit") {
      // A paste is still mid-flight — dropping this Enter avoids submitting
      // an input state that doesn't yet include the paste.
      if (pastePendingRef.current) return;
      submitInput(text);
      return;
    }

    const editAction = resolveComposerEditAction(input, key);
    if (editAction) {
      if (editAction === "word-left") {
        setCursor(previousWordBoundary(text, cursor));
      } else if (editAction === "word-right") {
        setCursor(nextWordBoundary(text, cursor));
      } else if (editAction === "line-start") {
        setCursor(lineStartBoundary(text, cursor));
      } else if (editAction === "line-end") {
        setCursor(lineEndBoundary(text, cursor));
      } else if (editAction === "delete-line-start") {
        const next = deleteToLineStart(text, cursor);
        setText(next.text);
        setCursor(next.cursor);
      } else {
        const next = deleteToLineEnd(text, cursor);
        setText(next.text);
        setCursor(next.cursor);
      }
      setSelectedIndex(0);
      return;
    }

    if (key.backspace) {
      if (cursor > 0) {
        const before = text.slice(0, cursor - 1);
        const after = text.slice(cursor);
        setText(before + after);
        setCursor(cursor - 1);
        setSelectedIndex(0);
      } else if (attachments.length > 0) {
        // Backspace at position 0 drops the most recent attachment so users
        // can undo a misfired paste without submitting the message.
        setAttachments((prev) => {
          const next = prev.slice(0, -1);
          if (next.length === 0) setImageLabelStartOverride(null);
          return next;
        });
        attachmentCountRef.current = Math.max(0, attachmentCountRef.current - 1);
      }
      return;
    }

    if (key.delete) {
      if (cursor < text.length) {
        const next = deleteAtCursor(text, cursor);
        setText(next.text);
        setCursor(next.cursor);
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
    if (key.upArrow || key.downArrow) {
      if (composerArrowDirection) {
        classifyVerticalArrow(composerArrowDirection);
      }
      return;
    }

    // Ctrl/meta chords are app-level shortcuts (Ctrl+S selection mode,
    // Ctrl+O trace, Ctrl+R thinking, …) — never type their letter. Raw C0
    // control bytes (kitty protocol off) are equally not text.
    if (key.ctrl || key.meta) return;
    if (input) {
      const printable = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      if (!printable) return;
      const before = text.slice(0, cursor);
      const after = text.slice(cursor);
      setText(before + printable + after);
      setCursor(cursor + printable.length);
      setSelectedIndex(0);
    }
  });

  // Anchor the cursor directly to whichever line Box currently contains the
  // cursor. Its absolute yoga (top, left) IS the row the cursor should land
  // on — no manual border/row offsets that can drift one row off after a
  // layout shift.
  const cursorLineRef = useRef<DOMElement | null>(null);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const previousOutputHeightRef = useRef<number | null>(null);
  const previousViewportRowsRef = useRef<number | null>(null);
  const previousInputFrameSignatureRef = useRef<string | null>(null);
  const previousRowCompensationRef = useRef(0);
  const lastCursorResetEpochRef = useRef<number | null>(null);
  const lastDraftEpochRef = useRef<number | null>(null);
  const lastWidthRef = useRef<number | null>(null);
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const [cursorTick, setCursorTick] = useState(0);

  useLayoutEffect(() => {
    const isInitialMount = lastCursorResetEpochRef.current === null;
    const shouldReset = !isInitialMount || cursorResetEpoch > 0;
    lastCursorResetEpochRef.current = cursorResetEpoch;
    if (!shouldReset) return;

    previousOutputHeightRef.current = null;
    previousViewportRowsRef.current = null;
    previousInputFrameSignatureRef.current = null;
    previousRowCompensationRef.current = 0;
    lastCursorRef.current = null;
    setCursorPosition(undefined);
    setCursorTick((t) => t + 1);
  }, [cursorResetEpoch, setCursorPosition]);

  useLayoutEffect(() => {
    if (lastDraftEpochRef.current === draftEpoch) return;
    lastDraftEpochRef.current = draftEpoch;
    if (!draftText) return;

    setText(draftText);
    setCursor(draftText.length);
    setSelectedIndex(0);
    setAttachments([]);
    attachmentCountRef.current = 0;
    setImageLabelStartOverride(null);
    setPastedContentRefs([]);
    nextPastedContentIndexRef.current = 1;
    setHistoryIndex(null);
    historyDraftRef.current = "";
    onDraftApplied?.();
  }, [draftEpoch, draftText, onDraftApplied]);

  useEffect(() => {
    if (text || attachments.length > 0) {
      submittedPayloadFingerprintRef.current = null;
    }
  }, [text, attachments.length]);

  // After a terminal resize the previous-frame refs reference a layout that no
  // longer exists; carrying them forward makes `needsCursorRowCompensation`
  // compare new yoga heights against stale ones and offsets the cursor by a
  // row. Reset to a "no previous frame" state so the next layout effect treats
  // the new width as a fresh start.
  useLayoutEffect(() => {
    if (lastWidthRef.current !== null && lastWidthRef.current !== width) {
      previousOutputHeightRef.current = null;
      previousViewportRowsRef.current = null;
      previousInputFrameSignatureRef.current = null;
      previousRowCompensationRef.current = 0;
      lastCursorRef.current = null;
    }
    lastWidthRef.current = width;
  }, [width]);

  const contentWidth = Math.max(1, width - PADDING_X * 2);
  const lineWidth = Math.max(1, contentWidth - PROMPT.length);
  const imageLabelStart = imageLabelStartOverride ?? nextImageLabelStart;
  const attachmentLabels = useMemo(
    () => attachments.map((_, index) => imageDisplayLabel(imageLabelStart + index)),
    [attachments, imageLabelStart],
  );
  // Labels are normally inline in `text` at their paste position. Only labels
  // that are NOT present inline (e.g. attachments restored from history) fall
  // back to a leading prefix so they stay visible.
  const unmarkedLabels = useMemo(
    () => attachmentLabels.filter((label) => !text.includes(label)),
    [attachmentLabels, text],
  );
  const imageInlinePrefix = unmarkedLabels.length > 0 ? `${unmarkedLabels.join(" ")} ` : "";
  const displayText = imageInlinePrefix + text;
  const displayCursor = cursor + imageInlinePrefix.length;
  const displayCursorToSourceCursor = (value: number) =>
    Math.max(0, Math.min(text.length, value - imageInlinePrefix.length));

  // Steady (non-blinking) cursor on purpose. The composer lives in the live
  // (repainting) region; a blink timer would rewrite these rows ~twice a second
  // even at idle, and the terminal drops any in-progress text selection every
  // time the underlying cells are rewritten — which is why composer text could
  // not be highlighted/copied while agent answers (committed to <Static>, never
  // repainted) could. Keeping the cursor steady leaves the idle composer frame
  // static, so native selection works. We still hide it while disabled.
  useEffect(() => {
    setSoftwareCursorVisible(!disabled);
  }, [disabled]);

  const visualLines = useMemo(
    () => computeVisualLines(displayText, lineWidth),
    [displayText, lineWidth],
  );
  const { row: cursorVisualRow, col: cursorVisualCol } = cursorToVisual(visualLines, displayCursor);

  // ---- Up/Down arrow handling in the composer ----
  //
  // Scrolling is the terminal's job now (native scrollback), so the composer
  // owns Up/Down unconditionally: move within multiline input first, then
  // browse prompt history at the top edge (Up → previous sent message) or the
  // bottom edge (Down → next message, then back to the in-progress draft).
  const performVerticalArrowRef = useRef<(direction: "up" | "down") => void>(() => {});
  performVerticalArrowRef.current = (direction) => {
    if (direction === "up") {
      if (cursorVisualRow > 0) {
        setCursor(displayCursorToSourceCursor(visualToCursor(visualLines, cursorVisualRow - 1, cursorVisualCol)));
        return;
      }
    } else {
      if (cursorVisualRow < visualLines.length - 1) {
        setCursor(displayCursorToSourceCursor(visualToCursor(visualLines, cursorVisualRow + 1, cursorVisualCol)));
        return;
      }
    }
    const result = stepHistory(
      { history, index: historyIndex, draft: historyDraftRef.current },
      direction,
      { text, images: attachments },
    );
    if (result.changed) {
      setText(result.text);
      setCursor(result.text.length);
      setAttachments(result.images ?? []);
      attachmentCountRef.current = (result.images ?? []).length;
      setImageLabelStartOverride(result.imageDisplayStart ?? null);
      setHistoryIndex(result.index);
      historyDraftRef.current = result.draft;
      setSelectedIndex(0);
      setPastedContentRefs([]);
      nextPastedContentIndexRef.current = 1;
    } else if (direction === "down") {
      // At the bottom edge with nothing newer in history: hand Down to the
      // parent so focus can move into the subagent entry (Claude Code parity).
      onArrowDownAtBottom?.();
    }
  };
  const classifyVerticalArrow = (direction: "up" | "down") => {
    performVerticalArrowRef.current(direction);
  };

  const lineFrame = shouldUseLineComposerFrame(theme.background);
  const minVisibleLines = lineFrame ? 1 : MIN_VISIBLE_LINES;
  const totalLines = Math.max(visualLines.length, 1);
  const visibleLines = Math.min(Math.max(totalLines, minVisibleLines), MAX_VISIBLE_LINES);

  let scrollOffset = 0;
  if (totalLines > visibleLines) {
    scrollOffset = Math.min(
      Math.max(cursorVisualRow - Math.floor(visibleLines / 2), 0),
      totalLines - visibleLines,
    );
  }

  type DisplayedInputLine =
    | { kind: "pad"; key: string }
    | { kind: "content"; text: string; visualIdx: number };

  const displayedLines: DisplayedInputLine[] = [];
  const topPadLines = totalLines < visibleLines
    ? Math.floor((visibleLines - totalLines) / 2)
    : 0;
  for (let i = 0; i < topPadLines; i++) {
    displayedLines.push({ kind: "pad", key: `top-${i}` });
  }
  const contentLineCount = Math.min(totalLines, visibleLines - topPadLines);
  for (let i = 0; i < contentLineCount; i++) {
    const visualIdx = scrollOffset + i;
    const vl = visualLines[visualIdx];
    displayedLines.push({
      kind: "content",
      text: vl ? vl.text : "",
      visualIdx,
    });
  }
  while (displayedLines.length < visibleLines) {
    displayedLines.push({ kind: "pad", key: `bottom-${displayedLines.length}` });
  }

  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + visibleLines < totalLines;
  const inputFrameSignature = [
    disabled ? "disabled" : "active",
    text,
    imageInlinePrefix,
    scrollOffset.toString(),
    visibleLines.toString(),
    attachments.map((att) => `${att.filename ?? "clipboard"}:${att.bytes}`).join(","),
    mode ?? "none",
    selectedIndex.toString(),
    suggestionOffset.toString(),
    activeCount.toString(),
    projectFiles?.length.toString() ?? "loading",
  ].join("\u0000");

  // Measure after yoga runs (useLayoutEffect fires after Ink's resetAfterCommit
  // calls onComputeLayout). Push the new position into useCursor's ref and bump
  // `cursorTick` to force one more render so useCursor's useInsertionEffect
  // sees the fresh value and Ink emits a cursor-only update.
  //
  // While the input is disabled (agent is running, pickers open, etc.) the
  // user can't type. Keeping the real cursor visible in the input makes it
  // flicker every time streaming output above it re-lays out the frame, so
  // we hide it entirely until input is active again.
  useLayoutEffect(() => {
    if (!hardwareCursorEnabled) {
      if (lastCursorRef.current !== null) {
        lastCursorRef.current = null;
      }
      setCursorPosition(undefined);
      return;
    }
    let node: DOMElement | undefined = cursorLineRef.current ?? undefined;
    if (!node?.yogaNode) {
      if (disabled && lastCursorRef.current !== null) {
        lastCursorRef.current = null;
        setCursorTick((t) => t + 1);
      }
      setCursorPosition(undefined);
      return;
    }
    let left = 0;
    let top = 0;
    let lastNode: DOMElement | undefined;
    const trace: string[] = [];
    while (node?.yogaNode) {
      const layout = node.yogaNode.getComputedLayout();
      left += layout.left;
      top += layout.top;
      if (process.env.BUBBLE_CURSOR_DEBUG) {
        trace.push(`${node.nodeName}(+${layout.left},+${layout.top})`);
      }
      lastNode = node;
      node = node.parentNode;
    }
    const rootHeight = lastNode?.yogaNode?.getComputedHeight() ?? 0;
    // `||` on purpose: some ptys (and Bun on a detached tty) report rows as 0,
    // which `??` would happily accept — and `rootHeight >= 0` then flags every
    // frame as fullscreen, forcing a bogus +1 row compensation.
    const viewportRows = stdout.rows || process.stdout.rows || 24;
    const previousOutputHeight = previousOutputHeightRef.current;
    // After a clear/sync frame, Ink's physical terminal cursor remains on the
    // last rendered row even though log-update records an output string with a
    // trailing newline. The forced cursor render that follows has the same
    // visible frame, so keep the same row compensation until the input frame
    // content or height actually changes.
    const sameRenderedFrame =
      previousOutputHeight === rootHeight &&
      previousViewportRowsRef.current === viewportRows &&
      previousInputFrameSignatureRef.current === inputFrameSignature;
    const rowCompensation = resolveCursorRowCompensation({
      sameRenderedFrame,
      previousRowCompensation: previousRowCompensationRef.current,
      nextOutputHeight: rootHeight,
      viewportRows,
      previousOutputHeight,
    });
    previousOutputHeightRef.current = rootHeight;
    previousViewportRowsRef.current = viewportRows;
    previousInputFrameSignatureRef.current = inputFrameSignature;
    previousRowCompensationRef.current = rowCompensation;

    if (disabled) {
      if (lastCursorRef.current !== null) {
        lastCursorRef.current = null;
        setCursorPosition(undefined);
        setCursorTick((t) => t + 1);
      }
      return;
    }

    const next = {
      x: left + PROMPT.length + cursorVisualCol,
      y: top + rowCompensation,
    };
    if (process.env.BUBBLE_CURSOR_DEBUG) {
      try {
        appendFileSync(
          "/tmp/bubble-cursor.log",
          `${new Date().toISOString()} row=${cursorVisualRow} col=${cursorVisualCol} -> x=${next.x} y=${next.y} (rootH=${rootHeight}, prevH=${previousOutputHeight ?? "none"}, vp=${viewportRows}, comp=${rowCompensation}) | ${trace.join(" < ")}\n`,
        );
      } catch {}
    }
    const prev = lastCursorRef.current;
    if (!prev || prev.x !== next.x || prev.y !== next.y) {
      lastCursorRef.current = next;
      setCursorPosition(next);
      setCursorTick((t) => t + 1);
    }
  });
  // Reference cursorTick so the effect re-runs on the forced render pass.
  void cursorTick;
  const inputBg = disabled ? theme.inputBgDisabled : theme.inputBg;
  const composerBg = composerSurfaceBackground(lineFrame, theme.background, inputBg);
  const rowBg = lineFrame ? undefined : inputBg;
  const cursorFg = lineFrame ? theme.background : inputBg;
  const cursorCellStyle = resolveSoftwareCursorCellStyle({
    visible: softwareCursorVisible,
    cursorBackground: theme.inputText,
    cursorForeground: cursorFg,
    textColor: theme.inputText,
    rowBackground: rowBg,
  });
  const moreBelow = totalLines - scrollOffset - visibleLines;

  const filledLine = (value: string) => {
    const visibleWidth = visualWidth(value);
    return value + " ".repeat(Math.max(0, contentWidth - visibleWidth));
  };

  return (
    <Box flexDirection="column" width={width} backgroundColor={theme.background}>
      {lineFrame && (
        <Box paddingX={PADDING_X}>
          <Text color={theme.border}>{"─".repeat(contentWidth)}</Text>
        </Box>
      )}
      <Box flexDirection="column" paddingX={PADDING_X} width={width} backgroundColor={composerBg}>
        {hasMoreAbove && (
          <Text backgroundColor={rowBg} color={theme.muted} dimColor>
            {filledLine(` ↑ ${scrollOffset} more`)}
          </Text>
        )}
        {displayedLines.map((row) => {
          if (row.kind === "pad") {
            return (
              <Text key={row.key} backgroundColor={rowBg}>
                {" ".repeat(contentWidth)}
              </Text>
            );
          }
          const { text: line, visualIdx } = row;
          const visualLine = visualLines[visualIdx];
          const lineText = line.length === 0 ? " " : line;
          const isFirst = visualIdx === 0;
          const isCursorLine = visualIdx === cursorVisualRow;
          const prompt = isFirst ? PROMPT : " ".repeat(PROMPT.length);
          const highlight = imageInlinePrefix ? null : slashCommandHighlight;
          const renderedSegments = splitComposerTextSegments({
            text: lineText,
            absStart: visualLine?.absStart ?? 0,
            highlight,
            cursorOffset: isCursorLine && !disabled
              ? displayCursor - (visualLines[cursorVisualRow]?.absStart ?? 0)
              : undefined,
          });
          const renderedLine = renderedSegments.map((segment) => segment.text).join("");
          const fill = " ".repeat(Math.max(0, lineWidth - visualWidth(renderedLine)));
          return (
            <Box
              key={visualIdx}
              height={1}
              overflow="hidden"
              backgroundColor={composerBg}
              ref={
                isCursorLine
                  ? (el: DOMElement | null) => {
                      cursorLineRef.current = el;
                    }
                  : undefined
              }
            >
              <Text backgroundColor={rowBg} color={isFirst ? theme.accent : theme.inputText}>
                {prompt}
              </Text>
              {renderedSegments.map((segment, index) => {
                if (segment.kind === "cursor") {
                  return (
                    <Text key={index} backgroundColor={cursorCellStyle.backgroundColor} color={cursorCellStyle.color}>
                      {segment.text}
                    </Text>
                  );
                }
                return (
                  <Text
                    key={index}
                    backgroundColor={rowBg}
                    color={segment.kind === "command" ? theme.accent : theme.inputText}
                    bold={segment.kind === "command"}
                  >
                    {segment.text}
                  </Text>
                );
              })}
              <Text backgroundColor={rowBg}>{fill}</Text>
            </Box>
          );
        })}
        {hasMoreBelow && (
          <Text backgroundColor={rowBg} color={theme.muted} dimColor>
            {filledLine(` ↓ ${moreBelow} more`)}
          </Text>
        )}
      </Box>
      {lineFrame && (
        <Box paddingX={PADDING_X}>
          <Text color={theme.border}>{"─".repeat(contentWidth)}</Text>
        </Box>
      )}
      {showSuggestions && mode === "slash" && (
        <Box flexDirection="column" marginTop={1} paddingLeft={4}>
          {slashSuggestions
            .slice(suggestionOffset, suggestionOffset + MAX_VISIBLE_SUGGESTIONS)
            .map((cmd, visibleIndex) => {
              const i = suggestionOffset + visibleIndex;
              const label = `/${cmd.name}`.padEnd(17);
              const isSelected = i === selectedIndex;
              return (
                <Box key={cmd.name} height={1}>
                  <Text>
                    <Text color={isSelected ? theme.accent : theme.muted} bold={isSelected}>{label}</Text>
                    {cmd.type === "skill" && <Text color={theme.muted}> [skill]</Text>}
                    <Text dimColor> {cmd.description}</Text>
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

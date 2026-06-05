/** @jsxImportSource @opentui/react */
/**
 * Composer input for the OpenTUI TUI. Manages a multi-line editable buffer,
 * cursor, history, file mention autocomplete, slash-command autocomplete,
 * and text + image paste. Simpler than the Ink version because OpenTUI
 * handles paste and selection at the native layer.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes } from "@opentui/core";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SkillRegistry } from "../skills/registry.js";
import { useTheme } from "./theme.js";
import { filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";
import {
  ingestClipboardImage,
  ingestImagePath,
  isImageFilePath,
  isScreenshotTempPath,
  splitPastedPaths,
  type ImageAttachment,
} from "./image-paste.js";
import {
  appendHistoryEntry,
  loadHistorySync,
  stepHistory,
} from "./input-history.js";
export {
  createPastedContentMarker,
  shouldCollapsePastedContent,
} from "../tui/paste-placeholder.js";
import {
  createPastedContentMarker,
  expandPastedContentMarkers,
  shouldCollapsePastedContent,
  type PastedContentReference,
} from "../tui/paste-placeholder.js";

export interface SubmitPayload {
  text: string;
  displayText?: string;
  images: ImageAttachment[];
}

interface InputBoxProps {
  onSubmit: (payload: SubmitPayload) => void;
  onPasteNotice?: (notice: string) => void;
  disabled?: boolean;
  cursorResetEpoch?: number;
  draftText?: string;
  draftEpoch?: number;
  onDraftApplied?: () => void;
  skillRegistry?: SkillRegistry;
  terminalColumns: number;
  cwd: string;
}

const PROMPT = " > ";
const MAX_VISIBLE_SUGGESTIONS = 8;

export function isCtrlCInput(input: string, key: { ctrl?: boolean }): boolean {
  return input === "\x03" || (key.ctrl === true && input.toLowerCase() === "c");
}

interface Suggestion {
  label: string;
  detail?: string;
  insert: string;
}

export function InputBox({
  onSubmit,
  onPasteNotice,
  disabled = false,
  cursorResetEpoch,
  draftText,
  draftEpoch,
  onDraftApplied,
  skillRegistry,
  terminalColumns,
  cwd,
}: InputBoxProps) {
  const theme = useTheme();
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [pastedRefs, setPastedRefs] = useState<PastedContentReference[]>([]);
  const [history] = useState(() => loadHistorySync());
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionKind, setSuggestionKind] = useState<"file" | "slash" | null>(null);

  // Refs mirror the latest values so handlers passed into useKeyboard / usePaste
  // read fresh state even if those hooks bind the callback once and never
  // re-subscribe on state change. Updated synchronously on every render so
  // the next event sees what just landed in the previous setState.
  const bufferRef = useRef(buffer);
  const cursorRef = useRef(cursor);
  const imagesRef = useRef(images);
  const pastedRefsRef = useRef(pastedRefs);
  const suggestionsRef = useRef(suggestions);
  const suggestionIndexRef = useRef(suggestionIndex);
  const suggestionKindRef = useRef(suggestionKind);
  const historyIndexRef = useRef(historyIndex);
  const nextPastedContentIndexRef = useRef(1);
  bufferRef.current = buffer;
  cursorRef.current = cursor;
  imagesRef.current = images;
  pastedRefsRef.current = pastedRefs;
  suggestionsRef.current = suggestions;
  suggestionIndexRef.current = suggestionIndex;
  suggestionKindRef.current = suggestionKind;
  historyIndexRef.current = historyIndex;

  // Reset cursor / buffer on epoch bump from app (used after /clear, etc).
  useEffect(() => {
    if (cursorResetEpoch === undefined) return;
    setBuffer("");
    setCursor(0);
    setImages([]);
    setPastedRefs([]);
    nextPastedContentIndexRef.current = 1;
    setSuggestions([]);
    setSuggestionKind(null);
    setHistoryIndex(null);
  }, [cursorResetEpoch]);

  // Accept draft text fill from outside (e.g. skill picker → composer).
  useEffect(() => {
    if (draftText === undefined || draftEpoch === undefined) return;
    setBuffer(draftText);
    setCursor(draftText.length);
    setPastedRefs([]);
    nextPastedContentIndexRef.current = 1;
    onDraftApplied?.();
  }, [draftText, draftEpoch, onDraftApplied]);

  const updateSuggestions = useCallback(async (text: string, cursorPos: number) => {
    const atCtx = findAtContext(text, cursorPos);
    if (atCtx) {
      const allFiles = await listProjectFiles(cwd);
      const files = filterFileSuggestions(allFiles, atCtx.query);
      if (files.length > 0) {
        setSuggestions(files.slice(0, MAX_VISIBLE_SUGGESTIONS).map((f) => ({
          label: f.path,
          insert: `@${f.path}`,
        })));
        setSuggestionIndex(0);
        setSuggestionKind("file");
        return;
      }
    }
    // Slash command suggestion if the buffer starts with /
    const slashMatch = /^\s*\/(\S*)$/.exec(text.slice(0, cursorPos));
    if (slashMatch) {
      const query = slashMatch[1] ?? "";
      const commands = slashRegistry.list?.() ?? [];
      const filtered = commands
        .filter((c: any) => !query || c.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, MAX_VISIBLE_SUGGESTIONS)
        .map((c: any) => ({
          label: `/${c.name}`,
          detail: c.description,
          insert: `/${c.name}`,
        }));
      if (filtered.length > 0) {
        setSuggestions(filtered);
        setSuggestionIndex(0);
        setSuggestionKind("slash");
        return;
      }
    }
    setSuggestions([]);
    setSuggestionKind(null);
  }, [cwd]);

  // All handlers read from refs so they stay correct under hooks that bind
  // the callback once. Writes still go through setState so React re-renders.
  const insertAtCursor = useCallback((text: string) => {
    const b = bufferRef.current;
    const c = cursorRef.current;
    const next = b.slice(0, c) + text + b.slice(c);
    const nextCursor = c + text.length;
    setBuffer(next);
    setCursor(nextCursor);
    void updateSuggestions(next, nextCursor);
  }, [updateSuggestions]);

  const acceptSuggestion = useCallback(() => {
    const b = bufferRef.current;
    const c = cursorRef.current;
    const sugs = suggestionsRef.current;
    const idx = suggestionIndexRef.current;
    const kind = suggestionKindRef.current;
    const s = sugs[idx];
    if (!s) return;
    if (kind === "file") {
      const atCtx = findAtContext(b, c);
      if (!atCtx) return;
      const next = b.slice(0, atCtx.start) + s.insert + b.slice(atCtx.end);
      const nextCursor = atCtx.start + s.insert.length;
      setBuffer(next);
      setCursor(nextCursor);
    } else if (kind === "slash") {
      const slashMatch = /^(\s*)\/(\S*)$/.exec(b);
      if (slashMatch) {
        const lead = slashMatch[1] ?? "";
        const next = `${lead}${s.insert} `;
        setBuffer(next);
        setCursor(next.length);
      }
    }
    setSuggestions([]);
    setSuggestionKind(null);
  }, []);

  const submit = useCallback(() => {
    const b = bufferRef.current;
    const imgs = imagesRef.current;
    const refs = pastedRefsRef.current;
    if (!b.trim() && imgs.length === 0) return;
    const expanded = expandPastedContentMarkers(b, refs);
    const payload: SubmitPayload = {
      text: expanded,
      displayText: expanded !== b ? b : undefined,
      images: imgs,
    };
    if (expanded.trim()) appendHistoryEntry(expanded);
    onSubmit(payload);
    setBuffer("");
    setCursor(0);
    setImages([]);
    setPastedRefs([]);
    nextPastedContentIndexRef.current = 1;
    setSuggestions([]);
    setSuggestionKind(null);
    setHistoryIndex(null);
  }, [onSubmit]);

  usePaste((event) => {
    if (disabled) return;
    const text = decodePasteBytes(event.bytes);
    // Detect image file paths from drag-and-drop or screenshot tools.
    const paths = splitPastedPaths(text);
    const imagePaths = paths.filter((p) => isImageFilePath(p) || isScreenshotTempPath(p));
    if (imagePaths.length > 0) {
      void Promise.all(imagePaths.map((p) => ingestImagePath(p))).then((results) => {
        const attachments: ImageAttachment[] = [];
        for (const r of results) {
          if (r.attachment) attachments.push(r.attachment);
        }
        if (attachments.length > 0) {
          setImages((prev) => [...prev, ...attachments]);
          onPasteNotice?.(`Attached ${attachments.length} image${attachments.length === 1 ? "" : "s"}`);
        }
      });
      return;
    }
    // Plain text: collapse if long, otherwise insert at cursor.
    if (shouldCollapsePastedContent(text)) {
      const marker = createPastedContentMarker(text, nextPastedContentIndexRef.current++);
      setPastedRefs((prev) => [...prev, { marker, content: text }]);
      insertAtCursor(marker);
    } else {
      insertAtCursor(text);
    }
  });

  useKeyboard((key) => {
    if (disabled) return;
    if (key.eventType === "release") return;

    // Pull latest state from refs at the top of each event — useKeyboard may
    // bind this handler once for the component's lifetime, so closure reads
    // of `buffer`/`cursor`/etc. would otherwise be stuck on initial values.
    const b = bufferRef.current;
    const c = cursorRef.current;
    const sugs = suggestionsRef.current;
    const hIndex = historyIndexRef.current;

    // Suggestion navigation
    if (sugs.length > 0) {
      if (key.name === "up") {
        setSuggestionIndex((i) => (i - 1 + sugs.length) % sugs.length);
        return;
      }
      if (key.name === "down") {
        setSuggestionIndex((i) => (i + 1) % sugs.length);
        return;
      }
      if (key.name === "tab" || key.name === "return") {
        acceptSuggestion();
        return;
      }
      if (key.name === "escape") {
        setSuggestions([]);
        setSuggestionKind(null);
        return;
      }
    }

    if (key.name === "return") {
      if (key.shift) {
        insertAtCursor("\n");
        return;
      }
      submit();
      return;
    }

    if (key.name === "backspace") {
      if (c === 0) return;
      const next = b.slice(0, c - 1) + b.slice(c);
      const nextCursor = c - 1;
      setBuffer(next);
      setCursor(nextCursor);
      void updateSuggestions(next, nextCursor);
      return;
    }
    if (key.name === "delete") {
      if (c === b.length) return;
      const next = b.slice(0, c) + b.slice(c + 1);
      setBuffer(next);
      void updateSuggestions(next, c);
      return;
    }
    if (key.name === "left") {
      if (key.option || key.ctrl) {
        setCursor(previousWordBoundary(b, c));
      } else {
        setCursor(Math.max(0, c - 1));
      }
      return;
    }
    if (key.name === "right") {
      if (key.option || key.ctrl) {
        setCursor(nextWordBoundary(b, c));
      } else {
        setCursor(Math.min(b.length, c + 1));
      }
      return;
    }
    if (key.name === "up") {
      if (hIndex !== null || b === "") {
        const next = stepHistory({ history, index: hIndex, draft: "" }, "up", b);
        if (next.changed) {
          setBuffer(next.text);
          setCursor(next.text.length);
          setHistoryIndex(next.index);
          setPastedRefs([]);
          nextPastedContentIndexRef.current = 1;
        }
        return;
      }
      const lineStart = b.lastIndexOf("\n", c - 1);
      if (lineStart === -1) return;
      const col = c - lineStart - 1;
      const prevLineEnd = lineStart;
      const prevLineStart = b.lastIndexOf("\n", prevLineEnd - 1) + 1;
      setCursor(Math.min(prevLineEnd, prevLineStart + col));
      return;
    }
    if (key.name === "down") {
      if (hIndex !== null) {
        const next = stepHistory({ history, index: hIndex, draft: "" }, "down", b);
        setBuffer(next.text);
        setCursor(next.text.length);
        setHistoryIndex(next.index);
        setPastedRefs([]);
        nextPastedContentIndexRef.current = 1;
        return;
      }
      const lineEnd = b.indexOf("\n", c);
      if (lineEnd === -1) return;
      const lineStart = b.lastIndexOf("\n", c - 1) + 1;
      const col = c - lineStart;
      const nextLineStart = lineEnd + 1;
      const nextLineEnd = b.indexOf("\n", nextLineStart);
      const limit = nextLineEnd === -1 ? b.length : nextLineEnd;
      setCursor(Math.min(limit, nextLineStart + col));
      return;
    }
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      const lineStart = b.lastIndexOf("\n", c - 1) + 1;
      setCursor(lineStart);
      return;
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      const lineEnd = b.indexOf("\n", c);
      setCursor(lineEnd === -1 ? b.length : lineEnd);
      return;
    }
    if (key.ctrl && key.name === "u") {
      const lineStart = b.lastIndexOf("\n", c - 1) + 1;
      const next = b.slice(0, lineStart) + b.slice(c);
      setBuffer(next);
      setCursor(lineStart);
      void updateSuggestions(next, lineStart);
      return;
    }
    if (key.ctrl && key.name === "k") {
      const lineEnd = b.indexOf("\n", c);
      const end = lineEnd === -1 ? b.length : lineEnd;
      const next = b.slice(0, c) + b.slice(end);
      setBuffer(next);
      void updateSuggestions(next, c);
      return;
    }

    // Character input — accept anything that's a printable string for key.name
    // and not a control combo. Multi-codepoint names (CJK input methods send
    // a fully-composed character; some terminals send 2+ codepoints for one
    // grapheme) are still treated as a single insert.
    if (key.name && !key.ctrl && isPrintableKeyName(key.name)) {
      insertAtCursor(key.name);
    }
  });

  const lines = buffer.split("\n");
  const placeholderActive = buffer === "" && images.length === 0;
  const railColor = disabled ? theme.inputBorderDisabled : theme.accent;
  const surfaceBg = disabled ? theme.shade : theme.surface;

  // Cursor position in visual lines.
  const cursorRow = (() => {
    const before = buffer.slice(0, cursor);
    return before.split("\n").length - 1;
  })();
  const cursorCol = (() => {
    const lastNl = buffer.lastIndexOf("\n", cursor - 1);
    return cursor - lastNl - 1;
  })();

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {suggestions.length > 0 && (
        <box style={{ flexDirection: "column", marginBottom: 0, paddingLeft: 3 }}>
          {suggestions.map((s, i) => (
            <text
              key={`sug-${i}`}
              fg={i === suggestionIndex ? theme.accent : theme.textMuted}
              attributes={i === suggestionIndex ? 1 : 0}
              content={`${i === suggestionIndex ? "▸ " : "  "}${s.label}${s.detail ? "  " + s.detail : ""}`}
            />
          ))}
        </box>
      )}
      {images.length > 0 && (
        <box style={{ paddingLeft: 3, marginBottom: 0 }}>
          <text fg={theme.accent} content={`${images.length} image${images.length === 1 ? "" : "s"} attached`} />
        </box>
      )}
      {/* opencode-style composer: heavy left rail in accent, surface fill,
          no top/right/bottom border, terminated at the bottom with ╹. */}
      {React.createElement(
        "box" as any,
        {
          style: {
            flexShrink: 0,
            backgroundColor: surfaceBg,
            flexDirection: "column",
            paddingTop: 1,
            paddingBottom: 1,
            paddingLeft: 2,
            paddingRight: 2,
          },
          border: ["left"],
          borderColor: railColor,
          customBorderChars: {
            topLeft: "",
            topRight: "",
            bottomLeft: "╹",
            bottomRight: "",
            horizontal: " ",
            vertical: "┃",
            topT: "",
            bottomT: "",
            cross: "",
            leftT: "",
            rightT: "",
          },
        },
        placeholderActive ? (
          <text
            key="placeholder"
            fg={theme.inputPlaceholder}
            content={disabled ? "Agent is responding…" : 'Ask anything... "Fix a TODO in the codebase"'}
          />
        ) : (
          lines.map((line, idx) => {
            const isCursorLine = idx === cursorRow;
            if (!isCursorLine) {
              return (
                <text key={`l-${idx}`} fg={theme.inputText} content={line || " "} />
              );
            }
            const before = line.slice(0, cursorCol);
            const at = line.slice(cursorCol, cursorCol + 1) || " ";
            const after = line.slice(cursorCol + 1);
            return (
              <box key={`l-${idx}`} style={{ flexDirection: "row" }}>
                <text fg={theme.inputText} content={before} />
                <text fg={theme.inputBg} bg={theme.accent} content={at} />
                <text fg={theme.inputText} content={after} />
              </box>
            );
          })
        ),
      )}
    </box>
  );
}

/**
 * True if `name` is a graphical character we should insert as-is (covers both
 * single ASCII codepoints and composed CJK characters delivered by an IME).
 * Filters out OpenTUI's named keys like "tab", "return", "f1", "pageup".
 */
function isPrintableKeyName(name: string): boolean {
  if (name.length === 0) return false;
  // Common named keys OpenTUI passes through as `key.name`. If a single
  // ASCII letter ends up here, length === 1 and it's not in this list, so it
  // gets inserted normally.
  const NAMED = new Set([
    "tab", "return", "enter", "escape", "backspace", "delete", "space",
    "up", "down", "left", "right",
    "home", "end", "pageup", "pagedown", "insert",
    "capslock", "numlock", "scrolllock", "printscreen", "pause",
  ]);
  if (NAMED.has(name)) return false;
  if (/^f\d{1,2}$/.test(name)) return false;     // f1..f24
  // Reject obvious control bytes if any sneak through.
  if (name.length === 1) {
    const cp = name.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return true;
}

function previousWordBoundary(text: string, cursor: number): number {
  if (cursor === 0) return 0;
  let i = cursor - 1;
  while (i > 0 && /\s/.test(text[i]!)) i--;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

function nextWordBoundary(text: string, cursor: number): number {
  if (cursor === text.length) return text.length;
  let i = cursor;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  return i;
}

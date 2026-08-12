import { describe, expect, it } from "vitest";
import {
  composerVerticalArrowDirection,
  createPastedContentMarker,
  deleteAtCursor,
  deleteToLineEnd,
  deleteToLineStart,
  expandPastedContentMarkers,
  insertNewlineAtCursor,
  isInkModifiedEnterInput,
  isCtrlCInput,
  isCtrlLetterInput,
  lineEndBoundary,
  lineStartBoundary,
  needsCursorRowCompensation,
  nextWordBoundary,
  previousWordBoundary,
  resolveComposerEditAction,
  resolveSoftwareCursorCellStyle,
  resolveCursorRowCompensation,
  resolveInkEnterIntent,
  resolveSlashEnterAction,
  resolveSlashCommandHighlightRange,
  shouldCollapsePastedContent,
  shouldDeferComposerCommitWhilePastePending,
  shouldUseHardwareComposerCursor,
  shouldSubmitExactSlashSuggestion,
  splitComposerTextSegments,
  splitLineAtCursor,
  stepComposerHistory,
} from "../tui-ink/input-box.js";
import {
  createComposerBuffer,
  expandComposerBuffer,
  hasActiveComposerPastes,
  insertComposerPaste,
  moveComposerCursor,
} from "../tui-ink/composer-buffer.js";

describe("Ink input cursor row compensation", () => {
  it("compensates fullscreen frames where Ink omits the trailing newline", () => {
    expect(needsCursorRowCompensation(24, 24, null)).toBe(true);
    expect(needsCursorRowCompensation(30, 24, 24)).toBe(true);
  });

  it("does not compensate ordinary non-fullscreen frames", () => {
    expect(needsCursorRowCompensation(20, 24, null)).toBe(false);
    expect(needsCursorRowCompensation(20, 24, 18)).toBe(false);
  });

  it("compensates the clear/sync frame after an overflowing response shrinks", () => {
    expect(needsCursorRowCompensation(20, 24, 30)).toBe(true);
    expect(needsCursorRowCompensation(20, 24, 24)).toBe(true);
  });

  it("does not compensate ordinary frames after picker close cursor reset", () => {
    expect(resolveCursorRowCompensation({
      sameRenderedFrame: false,
      previousRowCompensation: 0,
      nextOutputHeight: 6,
      viewportRows: 24,
      previousOutputHeight: null,
    })).toBe(0);
  });

  it("keeps existing compensation while the rendered input frame is unchanged", () => {
    expect(resolveCursorRowCompensation({
      sameRenderedFrame: true,
      previousRowCompensation: 1,
      nextOutputHeight: 6,
      viewportRows: 24,
      previousOutputHeight: 6,
    })).toBe(1);
  });
});

describe("Ink composer vertical arrows", () => {
  it("treats ordinary arrows as composer navigation", () => {
    expect(composerVerticalArrowDirection({ upArrow: true })).toBe("up");
    expect(composerVerticalArrowDirection({ downArrow: true })).toBe("down");
    expect(composerVerticalArrowDirection({ upArrow: true, eventType: "press" })).toBe("up");
    expect(composerVerticalArrowDirection({ downArrow: true, eventType: "repeat" })).toBe("down");
  });
});

describe("Ink composer hardware cursor", () => {
  it("keeps the terminal cursor opt-in so the software cursor is the only default visible cursor", () => {
    expect(shouldUseHardwareComposerCursor({})).toBe(false);
    expect(shouldUseHardwareComposerCursor({ BUBBLE_HARDWARE_CURSOR: "0" })).toBe(false);
    expect(shouldUseHardwareComposerCursor({ BUBBLE_HARDWARE_CURSOR: "1" })).toBe(true);
  });
});

describe("Ink composer edit shortcuts", () => {
  it("moves across words like a terminal composer", () => {
    const text = "alpha beta gamma";

    expect(previousWordBoundary(text, text.length)).toBe(11);
    expect(previousWordBoundary(text, 11)).toBe(6);
    expect(previousWordBoundary(text, 0)).toBe(0);
    expect(nextWordBoundary(text, 0)).toBe(5);
    expect(nextWordBoundary(text, 5)).toBe(10);
    expect(nextWordBoundary(text, text.length)).toBe(text.length);
  });

  it("finds current line boundaries in multiline composer text", () => {
    const text = "one\ntwo three\nfour";

    expect(lineStartBoundary(text, 8)).toBe(4);
    expect(lineEndBoundary(text, 8)).toBe(13);
    expect(lineStartBoundary(text, -10)).toBe(0);
    expect(lineEndBoundary(text, 999)).toBe(text.length);
  });

  it("deletes to the current line start or end without crossing newlines", () => {
    const text = "one\ntwo three\nfour";

    expect(deleteToLineStart(text, 8)).toEqual({ text: "one\nthree\nfour", cursor: 4 });
    expect(deleteToLineEnd(text, 8)).toEqual({ text: "one\ntwo \nfour", cursor: 8 });
  });

  it("deletes the character at the cursor for the Delete key", () => {
    expect(deleteAtCursor("abcd", 1)).toEqual({ text: "acd", cursor: 1 });
    expect(deleteAtCursor("abcd", 99)).toEqual({ text: "abcd", cursor: 4 });
    expect(deleteAtCursor("abcd", -1)).toEqual({ text: "bcd", cursor: 0 });
  });

  it("resolves Ctrl, Home/End, and modified arrow editor actions", () => {
    expect(resolveComposerEditAction("", { home: true })).toBe("line-start");
    expect(resolveComposerEditAction("", { end: true })).toBe("line-end");
    expect(resolveComposerEditAction("", { ctrl: true, leftArrow: true })).toBe("word-left");
    expect(resolveComposerEditAction("", { meta: true, rightArrow: true })).toBe("word-right");
    expect(resolveComposerEditAction("a", { ctrl: true })).toBe("line-start");
    expect(resolveComposerEditAction("\x01", {})).toBe("line-start");
    expect(resolveComposerEditAction("e", { ctrl: true })).toBe("line-end");
    expect(resolveComposerEditAction("\x05", {})).toBe("line-end");
    expect(resolveComposerEditAction("u", { ctrl: true })).toBe("delete-line-start");
    expect(resolveComposerEditAction("\x15", {})).toBe("delete-line-start");
    expect(resolveComposerEditAction("k", { ctrl: true })).toBe("delete-line-end");
    expect(resolveComposerEditAction("\x0b", {})).toBe("delete-line-end");
    expect(resolveComposerEditAction("r", { ctrl: true })).toBeNull();
  });
});

describe("Ink input slash command submission", () => {
  it("submits exact slash commands on Enter instead of autocompleting them", () => {
    expect(shouldSubmitExactSlashSuggestion("/quit", "quit")).toBe(true);
    expect(shouldSubmitExactSlashSuggestion("/quit ", "quit")).toBe(true);
    expect(shouldSubmitExactSlashSuggestion("/qui", "quit")).toBe(false);
    expect(shouldSubmitExactSlashSuggestion("/quit now", "quit")).toBe(false);
    expect(shouldSubmitExactSlashSuggestion("/quit", "quickstart")).toBe(false);
  });

  it("completes partial slash commands on Enter", () => {
    const suggestions = [{ name: "help" }, { name: "provider" }];

    expect(resolveSlashEnterAction("/", suggestions, 0)).toEqual({
      kind: "complete",
      text: "/help ",
    });
    expect(resolveSlashEnterAction("/prov", suggestions, 1)).toEqual({
      kind: "complete",
      text: "/provider ",
    });
  });

  it("submits exact slash commands on Enter even when suggestions are visible", () => {
    expect(resolveSlashEnterAction("/provider", [{ name: "provider" }], 0)).toEqual({
      kind: "submit",
    });
  });

  it("highlights only known slash command tokens at the start of the composer", () => {
    expect(resolveSlashCommandHighlightRange("/model deepseek", ["model"])).toEqual({
      start: 0,
      end: 6,
    });
    expect(resolveSlashCommandHighlightRange("/podcast 写稿", ["podcast"])).toEqual({
      start: 0,
      end: 8,
    });
    expect(resolveSlashCommandHighlightRange("/unknown arg", ["model"])).toBeNull();
    expect(resolveSlashCommandHighlightRange("please /model", ["model"])).toBeNull();
  });

  it("splits highlighted slash commands around the cursor cell", () => {
    expect(splitComposerTextSegments({
      text: "/model ",
      absStart: 0,
      highlight: { start: 0, end: 6 },
      cursorOffset: 3,
    })).toEqual([
      { kind: "command", text: "/mo" },
      { kind: "cursor", text: "d" },
      { kind: "command", text: "el" },
      { kind: "normal", text: " " },
    ]);
  });
});

describe("Ink input Enter handling", () => {
  it("defers submit and autocomplete keys while a paste operation is pending", () => {
    expect(shouldDeferComposerCommitWhilePastePending(true, "submit", {})).toBe(true);
    expect(shouldDeferComposerCommitWhilePastePending(true, "none", { tab: true })).toBe(true);
    expect(shouldDeferComposerCommitWhilePastePending(true, "newline", {})).toBe(false);
    expect(shouldDeferComposerCommitWhilePastePending(false, "submit", { tab: true })).toBe(false);
  });

  it("treats modified Enter as newline before submit/autocomplete handling", () => {
    expect(resolveInkEnterIntent("", { return: true, shift: true })).toBe("newline");
    expect(resolveInkEnterIntent("", { return: true, ctrl: true })).toBe("newline");
    expect(resolveInkEnterIntent("\r", { shift: true })).toBe("newline");
    expect(resolveInkEnterIntent("\n", { meta: true })).toBe("newline");
    expect(resolveInkEnterIntent(String.fromCodePoint(57345), { shift: true })).toBe("newline");
    expect(resolveInkEnterIntent("[27;2;13~", {})).toBe("newline");
    expect(resolveInkEnterIntent("\x1b[13;2u", {})).toBe("newline");
  });

  it("treats unmodified Enter as submit", () => {
    expect(resolveInkEnterIntent("", { return: true })).toBe("submit");
    expect(resolveInkEnterIntent("\r", {})).toBe("submit");
    expect(resolveInkEnterIntent("x", {})).toBe("none");
    expect(resolveInkEnterIntent("X", { shift: true })).toBe("none");
    expect(resolveInkEnterIntent("\r", { return: true, shift: true, eventType: "release" })).toBe("none");
  });

  it("inserts a newline at the cursor without dropping surrounding text", () => {
    expect(insertNewlineAtCursor("hello", 2)).toEqual({ text: "he\nllo", cursor: 3 });
    expect(insertNewlineAtCursor("hello", -1)).toEqual({ text: "\nhello", cursor: 1 });
    expect(insertNewlineAtCursor("hello", 99)).toEqual({ text: "hello\n", cursor: 6 });
  });

  it("detects Ink's raw modified Enter fallback forms", () => {
    expect(isInkModifiedEnterInput("[57345;2u")).toBe(true);
    expect(isInkModifiedEnterInput("\x1b[13;2:1u")).toBe(true);
    expect(isInkModifiedEnterInput("[27;5;13~")).toBe(true);
    expect(isInkModifiedEnterInput("[13u")).toBe(false);
    expect(isInkModifiedEnterInput("x")).toBe(false);
  });
});

describe("Ink Ctrl+C handling", () => {
  it("recognizes Ctrl+C from Ink key metadata and raw ETX input", () => {
    expect(isCtrlCInput("c", { ctrl: true })).toBe(true);
    expect(isCtrlCInput("C", { ctrl: true })).toBe(true);
    expect(isCtrlCInput("\x03", {})).toBe(true);
    expect(isCtrlCInput("c", {})).toBe(false);
    expect(isCtrlCInput("x", { ctrl: true })).toBe(false);
  });
});

describe("Ink app-level Ctrl shortcut handling", () => {
  it("recognizes Ctrl+O from Ink key metadata and raw SI input", () => {
    expect(isCtrlLetterInput("o", { ctrl: true }, "o")).toBe(true);
    expect(isCtrlLetterInput("O", { ctrl: true }, "o")).toBe(true);
    expect(isCtrlLetterInput("\x0f", {}, "o")).toBe(true);
    expect(isCtrlLetterInput("o", {}, "o")).toBe(false);
    expect(isCtrlLetterInput("x", { ctrl: true }, "o")).toBe(false);
  });

  it("ignores invalid shortcut letters", () => {
    expect(isCtrlLetterInput("\x0f", {}, "oo")).toBe(false);
    expect(isCtrlLetterInput("\x0f", {}, "1")).toBe(false);
  });
});

describe("Ink long paste placeholders", () => {
  it("collapses long text by character count or line count", () => {
    expect(shouldCollapsePastedContent("x".repeat(999))).toBe(false);
    expect(shouldCollapsePastedContent("x".repeat(1000))).toBe(true);
    expect(shouldCollapsePastedContent(Array.from({ length: 19 }, () => "x").join("\n"))).toBe(false);
    expect(shouldCollapsePastedContent(Array.from({ length: 20 }, () => "x").join("\n"))).toBe(true);
  });

  it("creates the visible pasted text marker", () => {
    expect(createPastedContentMarker("hello")).toBe("[Pasted text #1 +5 chars]");
    expect(createPastedContentMarker("a\nb\nc", 2)).toBe("[Pasted text #2 +3 lines]");
  });

  it("expands markers back to pasted content before submit", () => {
    const content = "long pasted body";
    const marker = createPastedContentMarker(content);

    expect(expandPastedContentMarkers(`Summarize:\n${marker}`, [
      { marker, content },
    ])).toBe(`Summarize:\n${content}`);
  });

  it("does not submit deleted pasted content", () => {
    const content = "deleted body";
    const marker = createPastedContentMarker(content);

    expect(expandPastedContentMarkers("Summarize:", [
      { marker, content },
    ])).toBe("Summarize:");
  });

  it("expands multiple pasted markers in order", () => {
    const first = "first pasted body";
    const second = "second pasted body";
    const firstMarker = createPastedContentMarker(first, 1);
    const secondMarker = createPastedContentMarker(second, 2);

    expect(expandPastedContentMarkers(`${firstMarker}\n---\n${secondMarker}`, [
      { marker: firstMarker, content: first },
      { marker: secondMarker, content: second },
    ])).toBe(`${first}\n---\n${second}`);
  });

  it("expands duplicate markers without re-scanning inserted content", () => {
    const first = "same length one";
    const second = "same length two";
    const marker = createPastedContentMarker(first);

    expect(expandPastedContentMarkers(`${marker}\n${marker}`, [
      { marker, content: first },
      { marker, content: second },
    ])).toBe(`${first}\n${second}`);
  });
});

describe("Ink atomic paste draft integration", () => {
  it("restores a transient history draft with paste identity and its next id intact", () => {
    let buffer = createComposerBuffer("before  after", "before ".length);
    buffer = insertComposerPaste(buffer, "original pasted body", "[paste one]");
    const liveDraft = {
      buffer,
      attachments: [{
        base64: "aGVsbG8=",
        mediaType: "image/png",
        bytes: 5,
        dataUrl: "data:image/png;base64,aGVsbG8=",
        filename: "draft.png",
      }],
      imageLabelStartOverride: 4,
      historyIndex: null,
      draftSnapshot: null,
    };

    const browsing = stepComposerHistory(
      liveDraft,
      [{ text: "persisted history", images: [] }],
      "up",
    );
    expect(browsing.buffer.text).toBe("persisted history");
    expect(browsing.buffer.pastes).toEqual([]);
    expect(browsing.draftSnapshot).not.toBeNull();

    const restored = stepComposerHistory(
      browsing,
      [{ text: "persisted history", images: [] }],
      "down",
    );
    expect(restored.buffer).not.toBe(buffer);
    expect(restored.attachments).not.toBe(liveDraft.attachments);
    expect(restored.historyIndex).toBeNull();
    expect(restored.draftSnapshot).toBeNull();
    expect(expandComposerBuffer(restored.buffer)).toBe("before original pasted body after");
    expect(restored.buffer.cursor).toBe(buffer.cursor);
    expect(restored.buffer.nextPasteId).toBe(2);
    expect(restored.imageLabelStartOverride).toBe(4);

    const withSecondPaste = insertComposerPaste(restored.buffer, "second", "[paste two]");
    expect(withSecondPaste.pastes.map((paste) => paste.id)).toEqual([1, 2]);
  });

  it("recalls long persisted history entries as collapsed markers without losing content", () => {
    const longA = "a".repeat(1200);
    const longB = "b".repeat(1500);
    const history = [{ text: longA, images: [] }, { text: longB, images: [] }];
    const fresh = {
      buffer: createComposerBuffer(""),
      attachments: [],
      imageLabelStartOverride: null,
      historyIndex: null as number | null,
      draftSnapshot: null,
    };

    // Up into the newest entry: shown as a marker, full content retained.
    const up = stepComposerHistory(fresh, history, "up");
    expect(up.buffer.text).toBe(createPastedContentMarker(longB, 1));
    expect(up.buffer.pastes).toHaveLength(1);
    expect(up.historyIndex).toBe(1);
    expect(expandComposerBuffer(up.buffer)).toBe(longB);

    // Up again into the older entry: same guarantee.
    const older = stepComposerHistory(up, history, "up");
    expect(older.buffer.text).toBe(createPastedContentMarker(longA, 1));
    expect(older.historyIndex).toBe(0);
    expect(expandComposerBuffer(older.buffer)).toBe(longA);

    // Down back into the newer entry still carries its full content.
    const newer = stepComposerHistory(older, history, "down");
    expect(newer.buffer.text).toBe(createPastedContentMarker(longB, 1));
    expect(newer.historyIndex).toBe(1);
    expect(expandComposerBuffer(newer.buffer)).toBe(longB);
  });

  it("loads marker-shaped persisted history as literal text without resurrecting hidden content", () => {
    const persisted = createComposerBuffer("[Pasted text #1 +9 lines]");
    expect(hasActiveComposerPastes(persisted)).toBe(false);
    expect(expandComposerBuffer(persisted)).toBe("[Pasted text #1 +9 lines]");
  });

  it("combines word-boundary navigation with token-aware cursor normalization", () => {
    let buffer = insertComposerPaste(createComposerBuffer("prefix ", 7), "body", "[paste token]");
    buffer = moveComposerCursor(buffer, buffer.text.length, "right");
    const target = previousWordBoundary(buffer.text, buffer.cursor);
    const moved = moveComposerCursor(buffer, target, "left");
    expect(moved.cursor).toBe("prefix ".length);
  });
});

describe("software cursor cell", () => {
  it("splits the line around the character under the cursor", () => {
    expect(splitLineAtCursor("hello", 1)).toEqual({ before: "h", at: "e", after: "llo" });
    expect(splitLineAtCursor("hello", 0)).toEqual({ before: "", at: "h", after: "ello" });
  });

  it("renders a space cell when the cursor sits at end of line", () => {
    expect(splitLineAtCursor("hi", 2)).toEqual({ before: "hi", at: " ", after: "" });
    expect(splitLineAtCursor(" ", 0)).toEqual({ before: "", at: " ", after: "" });
  });

  it("keeps surrogate pairs whole under the cursor", () => {
    expect(splitLineAtCursor("a😀b", 1)).toEqual({ before: "a", at: "😀", after: "b" });
    expect(splitLineAtCursor("中文字", 1)).toEqual({ before: "中", at: "文", after: "字" });
  });

  it("clamps offsets outside the line", () => {
    expect(splitLineAtCursor("hi", 99)).toEqual({ before: "hi", at: " ", after: "" });
    expect(splitLineAtCursor("hi", -1)).toEqual({ before: "", at: "h", after: "i" });
  });

  it("renders inverse video while visible and normal text while hidden", () => {
    expect(resolveSoftwareCursorCellStyle({
      visible: true,
      textColor: "text",
    })).toEqual({ inverse: true, color: "text" });

    expect(resolveSoftwareCursorCellStyle({
      visible: false,
      textColor: "text",
    })).toEqual({ inverse: false, color: "text" });
  });
});

import { describe, expect, it } from "vitest";
import {
  createPastedContentMarker,
  expandPastedContentMarkers,
  insertNewlineAtCursor,
  isInkModifiedEnterInput,
  isCtrlCInput,
  needsCursorRowCompensation,
  resolveCursorRowCompensation,
  resolveInkEnterIntent,
  resolveSlashEnterAction,
  resolveSlashCommandHighlightRange,
  shouldCollapsePastedContent,
  shouldSubmitExactSlashSuggestion,
  splitComposerTextSegments,
  splitLineAtCursor,
} from "../tui-ink/input-box.js";

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
});

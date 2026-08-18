import { describe, expect, it } from "vitest";
import {
  assertComposerBufferInvariant,
  cloneComposerBuffer,
  createComposerBuffer,
  deleteComposerBackward,
  deleteComposerForward,
  expandComposerBuffer,
  findActiveComposerPaste,
  getComposerBufferInvariantErrors,
  hasActiveComposerPastes,
  insertComposerPaste,
  insertComposerText,
  moveComposerCursor,
  replaceComposerRange,
  resetComposerBuffer,
  sanitizeComposerBuffer,
  type ComposerBuffer,
} from "../tui/model/composer-buffer.js";

const MARKER = "[Pasted text #1 +9 lines]";

function bufferWithPaste(prefix = "", suffix = "", marker = MARKER, content = "hidden body") {
  let buffer = createComposerBuffer(prefix + suffix, prefix.length);
  buffer = insertComposerPaste(buffer, content, marker);
  if (suffix) buffer = moveComposerCursor(buffer, buffer.text.length, "right");
  return buffer;
}

describe("composer buffer lifecycle", () => {
  it("creates, resets, and deeply clones plain buffers", () => {
    const created = createComposerBuffer("hello", 99);
    expect(created).toEqual({ text: "hello", cursor: 5, pastes: [], nextPasteId: 1 });

    const withPaste = insertComposerPaste(created, "body", MARKER);
    const clone = cloneComposerBuffer(withPaste);
    expect(clone).toEqual(withPaste);
    expect(clone).not.toBe(withPaste);
    expect(clone.pastes).not.toBe(withPaste.pastes);
    expect(clone.pastes[0]).not.toBe(withPaste.pastes[0]);

    expect(resetComposerBuffer("draft", 2)).toEqual({
      text: "draft",
      cursor: 2,
      pastes: [],
      nextPasteId: 1,
    });
  });

  it("preserves ordinary text insertion, replacement, deletion, and movement", () => {
    let buffer = createComposerBuffer("ac", 1);
    buffer = insertComposerText(buffer, "b");
    expect(buffer).toMatchObject({ text: "abc", cursor: 2, pastes: [] });

    buffer = replaceComposerRange(buffer, 1, 2, "BC");
    expect(buffer).toMatchObject({ text: "aBCc", cursor: 3 });
    buffer = deleteComposerBackward(buffer);
    expect(buffer).toMatchObject({ text: "aBc", cursor: 2 });
    buffer = deleteComposerForward(buffer);
    expect(buffer).toMatchObject({ text: "aB", cursor: 2 });
    expect(moveComposerCursor(buffer, -10, "left").cursor).toBe(0);
  });
});

describe("atomic paste deletion", () => {
  it("handles a paste followed immediately by Backspace as sequential transactions", () => {
    const initial = createComposerBuffer();
    const pasted = insertComposerPaste(initial, "body", MARKER);
    const deleted = deleteComposerBackward(pasted);

    expect(deleted).toMatchObject({ text: "", cursor: 0, pastes: [], nextPasteId: 2 });
  });

  it("Backspace at the trailing boundary removes the whole paste and preserves adjacent whitespace", () => {
    let buffer = bufferWithPaste("left ", " right");
    buffer = moveComposerCursor(buffer, "left ".length + MARKER.length, "right");
    const deleted = deleteComposerBackward(buffer);

    expect(deleted.text).toBe("left  right");
    expect(deleted.cursor).toBe("left ".length);
    expect(deleted.pastes).toEqual([]);
    expect(deleted.nextPasteId).toBe(2);
  });

  it("Backspace at the leading boundary deletes the preceding character, not the paste", () => {
    let buffer = bufferWithPaste("x ", " y");
    buffer = moveComposerCursor(buffer, 2, "left");
    const deleted = deleteComposerBackward(buffer);

    expect(deleted.text).toBe(`x${MARKER} y`);
    expect(deleted.pastes).toHaveLength(1);
    expect(deleted.pastes[0]?.start).toBe(1);
    expect(expandComposerBuffer(deleted)).toBe("xhidden body y");
  });

  it("Delete at the leading boundary removes the whole paste", () => {
    let buffer = bufferWithPaste("left ", " right");
    buffer = moveComposerCursor(buffer, "left ".length, "left");
    const deleted = deleteComposerForward(buffer);

    expect(deleted.text).toBe("left  right");
    expect(deleted.cursor).toBe("left ".length);
    expect(deleted.pastes).toEqual([]);
  });

  it("Delete at the trailing boundary deletes the following character, not the paste", () => {
    let buffer = bufferWithPaste("x ", " y");
    const end = 2 + MARKER.length;
    buffer = moveComposerCursor(buffer, end, "right");
    const deleted = deleteComposerForward(buffer);

    expect(deleted.text).toBe(`x ${MARKER}y`);
    expect(deleted.pastes).toHaveLength(1);
    expect(expandComposerBuffer(deleted)).toBe("x hidden bodyy");
  });

  it("uses affinity to disambiguate the shared boundary between adjacent pastes", () => {
    let buffer = insertComposerPaste(createComposerBuffer(), "first", "[one]");
    buffer = insertComposerPaste(buffer, "second", "[two]");
    const shared = "[one]".length;

    expect(findActiveComposerPaste(buffer, "backward", shared)?.content).toBe("first");
    expect(findActiveComposerPaste(buffer, "forward", shared)?.content).toBe("second");
    expect(deleteComposerBackward(moveComposerCursor(buffer, shared, "left")).text).toBe("[two]");
    expect(deleteComposerForward(moveComposerCursor(buffer, shared, "right")).text).toBe("[one]");
  });

  it("deletes the correct occurrence when two paste spans share the same marker text", () => {
    const duplicate = "[same]";
    let original = insertComposerPaste(createComposerBuffer(), "FIRST", duplicate);
    original = insertComposerText(original, " | ");
    original = insertComposerPaste(original, "SECOND", duplicate);

    const firstEnd = duplicate.length;
    const withoutFirst = deleteComposerBackward(moveComposerCursor(original, firstEnd, "right"));
    expect(expandComposerBuffer(withoutFirst)).toBe(" | SECOND");
    expect(withoutFirst.pastes.map((paste) => paste.id)).toEqual([2]);

    const secondStart = duplicate.length + " | ".length;
    const withoutSecond = deleteComposerForward(moveComposerCursor(original, secondStart, "left"));
    expect(expandComposerBuffer(withoutSecond)).toBe("FIRST | ");
    expect(withoutSecond.pastes.map((paste) => paste.id)).toEqual([1]);
  });
});

describe("atomic range edits and shifting", () => {
  it("widens a partial range intersection to remove the entire paste", () => {
    const buffer = bufferWithPaste("before ", " after");
    const startInside = "before ".length + 3;
    const replaced = replaceComposerRange(buffer, startInside, buffer.text.length - 3, "X");

    expect(replaced.text).toBe("before Xter");
    expect(replaced.cursor).toBe("before X".length);
    expect(replaced.pastes).toEqual([]);
  });

  it("removes every paste touched by a broad range", () => {
    let buffer = insertComposerPaste(createComposerBuffer("A", 1), "one", "[1]");
    buffer = insertComposerText(buffer, " mid ");
    buffer = insertComposerPaste(buffer, "two", "[2]");
    buffer = insertComposerText(buffer, " Z");
    const replaced = replaceComposerRange(buffer, 2, buffer.text.length - 1, "X");

    expect(replaced.text).toBe("AXZ");
    expect(replaced.pastes).toEqual([]);
  });

  it("does not consume a paste when a non-empty edit only touches its boundary", () => {
    const buffer = bufferWithPaste("ab", "cd");
    const replacedBefore = replaceComposerRange(buffer, 0, 2, "X");
    expect(replacedBefore.text).toBe(`X${MARKER}cd`);
    expect(replacedBefore.pastes[0]?.start).toBe(1);

    const tokenEnd = 1 + MARKER.length;
    const replacedAfter = replaceComposerRange(replacedBefore, tokenEnd, tokenEnd + 1, "Y");
    expect(replacedAfter.text).toBe(`X${MARKER}Yd`);
    expect(replacedAfter.pastes).toHaveLength(1);
  });

  it("shifts registered spans when plain text is inserted before them", () => {
    let buffer = bufferWithPaste("ab", "cd");
    buffer = moveComposerCursor(buffer, 0, "left");
    buffer = insertComposerText(buffer, "123");

    expect(buffer.pastes[0]?.start).toBe(5);
    expect(expandComposerBuffer(buffer)).toBe("123abhidden bodycd");
  });

  it("snaps zero-width insertions inside a paste to the requested boundary", () => {
    const buffer = bufferWithPaste("A", "Z");
    const inside = 1 + Math.floor(MARKER.length / 2);
    const left = replaceComposerRange(buffer, inside, inside, "L", "left");
    const right = replaceComposerRange(buffer, inside, inside, "R", "right");

    expect(left.text).toBe(`AL${MARKER}Z`);
    expect(left.pastes[0]?.start).toBe(2);
    expect(right.text).toBe(`A${MARKER}RZ`);
    expect(right.pastes[0]?.start).toBe(1);
  });

  it("preserves adjacent newlines when deleting a paste between them", () => {
    let buffer = insertComposerPaste(createComposerBuffer("before\n\nafter", 7), "body", MARKER);
    buffer = deleteComposerBackward(buffer);

    expect(buffer.text).toBe("before\n\nafter");
    expect(buffer.cursor).toBe(7);
  });

  it("widens Ctrl-U and Ctrl-K style line ranges instead of leaving marker fragments", () => {
    let buffer = insertComposerPaste(createComposerBuffer("head\nprefix  suffix\ntail", 12), "body", MARKER);
    const markerStart = 12;
    const markerEnd = markerStart + MARKER.length;

    const ctrlU = replaceComposerRange(
      moveComposerCursor(buffer, markerEnd, "right"),
      "head\n".length,
      markerEnd,
    );
    expect(ctrlU.text).toBe("head\n suffix\ntail");
    expect(ctrlU.pastes).toEqual([]);

    const lineEnd = buffer.text.indexOf("\n", markerEnd);
    const ctrlK = replaceComposerRange(
      moveComposerCursor(buffer, markerStart, "left"),
      markerStart,
      lineEnd,
    );
    expect(ctrlK.text).toBe("head\nprefix \ntail");
    expect(ctrlK.pastes).toEqual([]);
  });
});

describe("atomic cursor movement", () => {
  it("uses directional and nearest bias without leaving the cursor inside a paste", () => {
    const buffer = bufferWithPaste("A", "Z");
    const inside = 1 + Math.floor(MARKER.length / 2);
    expect(moveComposerCursor(buffer, inside, "left").cursor).toBe(1);
    expect(moveComposerCursor(buffer, inside, "right").cursor).toBe(1 + MARKER.length);

    const nearLeft = moveComposerCursor(buffer, 2, "nearest");
    const nearRight = moveComposerCursor(buffer, MARKER.length, "nearest");
    expect(nearLeft.cursor).toBe(1);
    expect(nearRight.cursor).toBe(1 + MARKER.length);
    expect(() => assertComposerBufferInvariant(nearLeft)).not.toThrow();
    expect(() => assertComposerBufferInvariant(nearRight)).not.toThrow();
  });

  it("deletes the full paste when a corrupted cursor starts inside it", () => {
    const valid = bufferWithPaste("A", "Z");
    const inside: ComposerBuffer = { ...valid, cursor: 3 };
    expect(deleteComposerBackward(inside).text).toBe("AZ");
    expect(deleteComposerForward(inside).text).toBe("AZ");
  });
});

describe("paste identity and expansion", () => {
  it("distinguishes duplicate marker labels by id and span while leaving lookalikes literal", () => {
    const duplicate = "[same marker]";
    let buffer = insertComposerPaste(createComposerBuffer(), "FIRST", duplicate);
    buffer = insertComposerText(buffer, ` / ${duplicate} / `);
    buffer = insertComposerPaste(buffer, "SECOND", duplicate);

    expect(buffer.pastes.map((paste) => paste.id)).toEqual([1, 2]);
    expect(expandComposerBuffer(buffer)).toBe(`FIRST / ${duplicate} / SECOND`);
    expect(hasActiveComposerPastes(buffer)).toBe(true);
  });

  it("never recursively expands marker-like pasted content", () => {
    let buffer = insertComposerPaste(createComposerBuffer(), "[two]", "[one]");
    buffer = insertComposerText(buffer, " ");
    buffer = insertComposerPaste(buffer, "EXPANDED", "[two]");

    expect(expandComposerBuffer(buffer)).toBe("[two] EXPANDED");
  });

  it("keeps ids monotonic after deletion and resets them only with a new buffer", () => {
    let buffer = insertComposerPaste(createComposerBuffer(), "first", "[first]");
    buffer = deleteComposerBackward(buffer);
    buffer = insertComposerPaste(buffer, "second", "[second]");

    expect(buffer.pastes[0]?.id).toBe(2);
    expect(buffer.nextPasteId).toBe(3);
    expect(insertComposerPaste(resetComposerBuffer(), "new", "[new]").pastes[0]?.id).toBe(1);
  });

  it("clones a transient draft without losing expansion identity", () => {
    const buffer = bufferWithPaste("summarize ", " please");
    const restored = cloneComposerBuffer(buffer);
    expect(expandComposerBuffer(restored)).toBe("summarize hidden body please");
    expect(restored.nextPasteId).toBe(buffer.nextPasteId);
  });
});

describe("fail-closed sanitization and invariants", () => {
  it("drops mismatched spans while preserving their marker-like text literally", () => {
    const invalid: ComposerBuffer = {
      text: "literal marker",
      cursor: 7,
      pastes: [{ id: 4, start: 0, marker: "different", content: "SECRET" }],
      nextPasteId: 2,
    };
    const sanitized = sanitizeComposerBuffer(invalid);

    expect(sanitized.text).toBe("literal marker");
    expect(sanitized.pastes).toEqual([]);
    expect(sanitized.nextPasteId).toBe(5);
    expect(expandComposerBuffer(invalid)).toBe("literal marker");
    expect(hasActiveComposerPastes(invalid)).toBe(false);
    expect(deleteComposerForward(invalid).text).toBe("literalmarker");
  });

  it("drops every ambiguous overlap or duplicate id", () => {
    const overlapping: ComposerBuffer = {
      text: "TOKEN TOKEN",
      cursor: 11,
      pastes: [
        { id: 1, start: 0, marker: "TOKEN", content: "A" },
        { id: 2, start: 0, marker: "TOKEN", content: "B" },
        { id: 3, start: 6, marker: "TOKEN", content: "C" },
        { id: 3, start: 6, marker: "TOKEN", content: "D" },
      ],
      nextPasteId: 1,
    };

    const sanitized = sanitizeComposerBuffer(overlapping);
    expect(sanitized.pastes).toEqual([]);
    expect(sanitized.nextPasteId).toBe(4);
    expect(expandComposerBuffer(overlapping)).toBe("TOKEN TOKEN");
  });

  it("reports malformed buffers and accepts sanitized ones", () => {
    const invalid: ComposerBuffer = {
      text: MARKER,
      cursor: 3,
      pastes: [{ id: 1, start: 0, marker: MARKER, content: "body" }],
      nextPasteId: 1,
    };
    expect(getComposerBufferInvariantErrors(invalid)).toEqual(expect.arrayContaining([
      "cursor must not be inside a paste span",
      "nextPasteId must be greater than every paste id",
    ]));
    expect(() => assertComposerBufferInvariant(invalid)).toThrow("Invalid composer buffer");

    const sanitized = sanitizeComposerBuffer(invalid, "right");
    expect(sanitized.cursor).toBe(MARKER.length);
    expect(sanitized.nextPasteId).toBe(2);
    expect(() => assertComposerBufferInvariant(sanitized)).not.toThrow();
  });
});

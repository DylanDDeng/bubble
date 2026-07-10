import { createPastedContentMarker } from "../tui/paste-placeholder.js";

/**
 * Cursor offsets and paste starts are UTF-16 string offsets, matching the rest
 * of the Ink composer and JavaScript's slice semantics.
 */
export interface ComposerPasteSpan {
  /** Stable identity for this paste occurrence. Marker text is not identity. */
  id: number;
  /** Inclusive offset of marker in `ComposerBuffer.text`. */
  start: number;
  marker: string;
  content: string;
}

export interface ComposerBuffer {
  text: string;
  cursor: number;
  pastes: ComposerPasteSpan[];
  /** Monotonic within a live draft; removed paste ids are never reused. */
  nextPasteId: number;
}

export type ComposerCursorBias = "left" | "right" | "nearest";
export type ComposerPasteAffinity = "inside" | "backward" | "forward";

export interface ComposerPasteInsertion {
  content: string;
  /** Primarily useful for tests and alternate labels. Identity still comes from `id`. */
  marker?: string;
}

interface SanitizedCore {
  text: string;
  cursor: number;
  pastes: ComposerPasteSpan[];
  nextPasteId: number;
}

interface PasteCandidate extends ComposerPasteSpan {
  end: number;
  sourceIndex: number;
}

function clampOffset(text: string, value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(text.length, Math.trunc(value)));
}

function pasteEnd(paste: ComposerPasteSpan): number {
  return paste.start + paste.marker.length;
}

function safeNextPasteId(buffer: ComposerBuffer): number {
  const supplied = Number.isSafeInteger(buffer.nextPasteId) && buffer.nextPasteId > 0
    ? buffer.nextPasteId
    : 1;
  let next = supplied;
  for (const paste of buffer.pastes) {
    if (Number.isSafeInteger(paste?.id) && paste.id > 0) {
      next = Math.max(next, paste.id + 1);
    }
  }
  return next;
}

/**
 * Keep only spans that are independently valid and unambiguous. Invalid,
 * overlapping, or duplicate-id spans fail closed: their visible marker text
 * remains ordinary literal text and their hidden content is never used.
 */
function sanitizeCore(buffer: ComposerBuffer): SanitizedCore {
  const text = typeof buffer.text === "string" ? buffer.text : "";
  const rawPastes = Array.isArray(buffer.pastes) ? buffer.pastes : [];
  const idCounts = new Map<number, number>();
  for (const paste of rawPastes) {
    if (Number.isSafeInteger(paste?.id) && paste.id > 0) {
      idCounts.set(paste.id, (idCounts.get(paste.id) ?? 0) + 1);
    }
  }

  const candidates: PasteCandidate[] = [];
  for (let sourceIndex = 0; sourceIndex < rawPastes.length; sourceIndex++) {
    const paste = rawPastes[sourceIndex];
    if (!paste || !Number.isSafeInteger(paste.id) || paste.id <= 0) continue;
    if (!Number.isSafeInteger(paste.start) || paste.start < 0) continue;
    if (typeof paste.marker !== "string" || paste.marker.length === 0) continue;
    if (typeof paste.content !== "string") continue;
    const end = paste.start + paste.marker.length;
    if (!Number.isSafeInteger(end) || end > text.length) continue;
    if (text.slice(paste.start, end) !== paste.marker) continue;
    candidates.push({ ...paste, end, sourceIndex });
  }

  candidates.sort((a, b) => a.start - b.start || a.end - b.end || a.sourceIndex - b.sourceIndex);
  const conflicting = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i]!;
    if ((idCounts.get(current.id) ?? 0) > 1) conflicting.add(i);
    for (let j = i - 1; j >= 0; j--) {
      const previous = candidates[j]!;
      if (previous.end > current.start) {
        conflicting.add(i);
        conflicting.add(j);
      }
    }
  }

  const pastes = candidates
    .filter((_, index) => !conflicting.has(index))
    .map(({ end: _end, sourceIndex: _sourceIndex, ...paste }) => paste);

  return {
    text,
    cursor: clampOffset(text, buffer.cursor),
    pastes,
    nextPasteId: safeNextPasteId({ ...buffer, text, pastes: rawPastes }),
  };
}

function normalizeWithPastes(
  text: string,
  pastes: readonly ComposerPasteSpan[],
  requested: number,
  bias: ComposerCursorBias,
): number {
  const cursor = clampOffset(text, requested);
  for (const paste of pastes) {
    const end = pasteEnd(paste);
    if (paste.start < cursor && cursor < end) {
      if (bias === "left") return paste.start;
      if (bias === "right") return end;
      const leftDistance = cursor - paste.start;
      const rightDistance = end - cursor;
      return leftDistance <= rightDistance ? paste.start : end;
    }
  }
  return cursor;
}

function normalizedCore(buffer: ComposerBuffer, bias: ComposerCursorBias = "nearest"): ComposerBuffer {
  const core = sanitizeCore(buffer);
  return {
    ...core,
    cursor: normalizeWithPastes(core.text, core.pastes, core.cursor, bias),
  };
}

export function createComposerBuffer(text = "", cursor = text.length): ComposerBuffer {
  const safeText = typeof text === "string" ? text : "";
  return {
    text: safeText,
    cursor: clampOffset(safeText, cursor),
    pastes: [],
    nextPasteId: 1,
  };
}

/** Full replacement: pasted spans and their id sequence belong to the old draft. */
export function resetComposerBuffer(text = "", cursor = text.length): ComposerBuffer {
  return createComposerBuffer(text, cursor);
}

/** Deep enough for a non-persisted history draft snapshot. Strings are immutable. */
export function cloneComposerBuffer(buffer: ComposerBuffer): ComposerBuffer {
  return {
    text: buffer.text,
    cursor: buffer.cursor,
    pastes: buffer.pastes.map((paste) => ({ ...paste })),
    nextPasteId: buffer.nextPasteId,
  };
}

export function sanitizeComposerBuffer(
  buffer: ComposerBuffer,
  cursorBias: ComposerCursorBias = "nearest",
): ComposerBuffer {
  return normalizedCore(buffer, cursorBias);
}

export function normalizeComposerCursor(
  buffer: ComposerBuffer,
  requested: number,
  bias: ComposerCursorBias = "nearest",
): number {
  const core = sanitizeCore(buffer);
  return normalizeWithPastes(core.text, core.pastes, requested, bias);
}

/**
 * Replace a half-open range. Any non-empty edit touching part of a registered
 * paste widens to remove that whole paste. A zero-width insertion inside a
 * paste snaps to the requested boundary without removing it.
 */
export function replaceComposerRange(
  buffer: ComposerBuffer,
  requestedStart: number,
  requestedEnd: number,
  insertion = "",
  insertionBias: ComposerCursorBias = "nearest",
): ComposerBuffer {
  const core = sanitizeCore(buffer);
  let start = clampOffset(core.text, requestedStart);
  let end = clampOffset(core.text, requestedEnd);
  if (start > end) [start, end] = [end, start];

  if (start === end) {
    start = normalizeWithPastes(core.text, core.pastes, start, insertionBias);
    end = start;
  } else {
    for (const paste of core.pastes) {
      const tokenEnd = pasteEnd(paste);
      if (paste.start < end && tokenEnd > start) {
        start = Math.min(start, paste.start);
        end = Math.max(end, tokenEnd);
      }
    }
  }

  const nextText = core.text.slice(0, start) + insertion + core.text.slice(end);
  const delta = insertion.length - (end - start);
  const nextPastes: ComposerPasteSpan[] = [];
  for (const paste of core.pastes) {
    const tokenEnd = pasteEnd(paste);
    if (tokenEnd <= start) {
      nextPastes.push(paste);
      continue;
    }
    if (paste.start >= end) {
      nextPastes.push({ ...paste, start: paste.start + delta });
    }
    // Anything else intersects the widened replacement and is removed.
  }

  return normalizedCore({
    text: nextText,
    cursor: start + insertion.length,
    pastes: nextPastes,
    nextPasteId: core.nextPasteId,
  });
}

export function insertComposerText(buffer: ComposerBuffer, text: string): ComposerBuffer {
  return replaceComposerRange(buffer, buffer.cursor, buffer.cursor, text, "nearest");
}

export function insertComposerPaste(buffer: ComposerBuffer, content: string, marker?: string): ComposerBuffer;
export function insertComposerPaste(buffer: ComposerBuffer, paste: ComposerPasteInsertion): ComposerBuffer;
export function insertComposerPaste(
  buffer: ComposerBuffer,
  contentOrPaste: string | ComposerPasteInsertion,
  markerOverride?: string,
): ComposerBuffer {
  const core = normalizedCore(buffer);
  const content = typeof contentOrPaste === "string" ? contentOrPaste : contentOrPaste.content;
  const suppliedMarker = typeof contentOrPaste === "string" ? markerOverride : contentOrPaste.marker;
  const id = core.nextPasteId;
  const marker = suppliedMarker ?? createPastedContentMarker(content, id);

  // Never hide content behind an unusable marker.
  if (marker.length === 0) return insertComposerText(core, content);

  const start = core.cursor;
  const inserted = replaceComposerRange(core, start, start, marker, "nearest");
  const paste: ComposerPasteSpan = { id, start, marker, content };
  const pastes = [...inserted.pastes, paste].sort((a, b) => a.start - b.start || a.id - b.id);
  return normalizedCore({
    ...inserted,
    pastes,
    nextPasteId: id + 1,
    cursor: start + marker.length,
  });
}

export function deleteComposerBackward(buffer: ComposerBuffer): ComposerBuffer {
  const core = sanitizeCore(buffer);
  const cursor = core.cursor;
  const paste = core.pastes.find((item) => item.start < cursor && cursor <= pasteEnd(item));
  if (paste) {
    return replaceComposerRange(core, paste.start, pasteEnd(paste));
  }
  if (cursor <= 0) return normalizedCore(core);
  return replaceComposerRange(core, cursor - 1, cursor);
}

export function deleteComposerForward(buffer: ComposerBuffer): ComposerBuffer {
  const core = sanitizeCore(buffer);
  const cursor = core.cursor;
  const paste = core.pastes.find((item) => item.start <= cursor && cursor < pasteEnd(item));
  if (paste) {
    return replaceComposerRange(core, paste.start, pasteEnd(paste));
  }
  if (cursor >= core.text.length) return normalizedCore(core);
  return replaceComposerRange(core, cursor, cursor + 1);
}

export function moveComposerCursor(
  buffer: ComposerBuffer,
  requested: number,
  bias: ComposerCursorBias = "nearest",
): ComposerBuffer {
  const core = sanitizeCore(buffer);
  return {
    ...core,
    cursor: normalizeWithPastes(core.text, core.pastes, requested, bias),
  };
}

export function findActiveComposerPaste(
  buffer: ComposerBuffer,
  affinity: ComposerPasteAffinity = "inside",
  requestedCursor = buffer.cursor,
): ComposerPasteSpan | null {
  const core = sanitizeCore(buffer);
  const cursor = clampOffset(core.text, requestedCursor);
  const paste = core.pastes.find((item) => {
    const end = pasteEnd(item);
    if (affinity === "backward") return item.start < cursor && cursor <= end;
    if (affinity === "forward") return item.start <= cursor && cursor < end;
    return item.start < cursor && cursor < end;
  });
  return paste ? { ...paste } : null;
}

export function hasActiveComposerPastes(buffer: ComposerBuffer): boolean {
  return sanitizeCore(buffer).pastes.length > 0;
}

/**
 * Expand registered spans only. Descending replacement keeps every earlier
 * UTF-16 offset stable and never scans inserted content, so expansion cannot
 * recurse through marker-like pasted text.
 */
export function expandComposerBuffer(buffer: ComposerBuffer): string {
  const core = sanitizeCore(buffer);
  let expanded = core.text;
  const descending = [...core.pastes].sort((a, b) => b.start - a.start || b.id - a.id);
  for (const paste of descending) {
    const end = pasteEnd(paste);
    expanded = expanded.slice(0, paste.start) + paste.content + expanded.slice(end);
  }
  return expanded;
}

export function getComposerBufferInvariantErrors(buffer: ComposerBuffer): string[] {
  const errors: string[] = [];
  if (typeof buffer.text !== "string") errors.push("text must be a string");
  const text = typeof buffer.text === "string" ? buffer.text : "";
  if (!Number.isSafeInteger(buffer.cursor) || buffer.cursor < 0 || buffer.cursor > text.length) {
    errors.push("cursor must be an in-bounds integer");
  }
  if (!Number.isSafeInteger(buffer.nextPasteId) || buffer.nextPasteId <= 0) {
    errors.push("nextPasteId must be a positive integer");
  }
  if (!Array.isArray(buffer.pastes)) {
    errors.push("pastes must be an array");
    return errors;
  }

  const ids = new Set<number>();
  let previousEnd = 0;
  let maxId = 0;
  for (let index = 0; index < buffer.pastes.length; index++) {
    const paste = buffer.pastes[index]!;
    if (!Number.isSafeInteger(paste.id) || paste.id <= 0) {
      errors.push(`paste ${index} id must be a positive integer`);
    } else {
      if (ids.has(paste.id)) errors.push(`paste id ${paste.id} is duplicated`);
      ids.add(paste.id);
      maxId = Math.max(maxId, paste.id);
    }
    if (!Number.isSafeInteger(paste.start) || paste.start < 0) {
      errors.push(`paste ${index} start must be a non-negative integer`);
      continue;
    }
    if (typeof paste.marker !== "string" || paste.marker.length === 0) {
      errors.push(`paste ${index} marker must be non-empty`);
      continue;
    }
    const end = pasteEnd(paste);
    if (end > text.length || text.slice(paste.start, end) !== paste.marker) {
      errors.push(`paste ${index} marker does not match text`);
    }
    if (index > 0 && paste.start < previousEnd) {
      errors.push(`paste ${index} overlaps or is out of order`);
    }
    previousEnd = Math.max(previousEnd, end);
    if (paste.start < buffer.cursor && buffer.cursor < end) {
      errors.push("cursor must not be inside a paste span");
    }
  }
  if (buffer.nextPasteId <= maxId) {
    errors.push("nextPasteId must be greater than every paste id");
  }
  return errors;
}

export function assertComposerBufferInvariant(buffer: ComposerBuffer): void {
  const errors = getComposerBufferInvariantErrors(buffer);
  if (errors.length > 0) {
    throw new Error(`Invalid composer buffer: ${errors.join("; ")}`);
  }
}

export interface EditOperation {
  oldText: string;
  newText: string;
}

export type EditMatchMode = "exact" | "normalized-line";

export interface EditMatchInfo {
  editIndex: number;
  mode: EditMatchMode;
  start: number;
  end: number;
}

export interface AppliedEditResult {
  content: string;
  normalizedOriginal: string;
  normalizedNext: string;
  bom: string;
  lineEnding: "\n" | "\r\n";
  matches: EditMatchInfo[];
}

export class EditApplyError extends Error {
  constructor(
    message: string,
    readonly status: "no_match" | "blocked" = "no_match",
  ) {
    super(message);
    this.name = "EditApplyError";
  }
}

interface LineInfo {
  text: string;
  start: number;
  endNoNewline: number;
}

interface NonBlankLine {
  lineIndex: number;
  normalized: string;
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  return crlf !== -1 && crlf === lf - 1 ? "\r\n" : "\n";
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function normalizeLineForMatch(line: string): string {
  return line
    .normalize("NFKC")
    .trimEnd()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function findAllOccurrences(content: string, needle: string): number[] {
  const indexes: number[] = [];
  if (needle.length === 0) return indexes;

  let index = content.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = content.indexOf(needle, index + needle.length);
  }
  return indexes;
}

function splitLines(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      lines.push({ text: content.slice(start, i), start, endNoNewline: i });
      start = i + 1;
    }
  }
  lines.push({ text: content.slice(start), start, endNoNewline: content.length });
  return lines;
}

function nonBlankLines(lines: LineInfo[]): NonBlankLine[] {
  const result: NonBlankLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeLineForMatch(lines[i].text);
    if (normalized.trim().length > 0) {
      result.push({ lineIndex: i, normalized });
    }
  }
  return result;
}

function normalizedOldNonBlankLines(oldText: string): string[] {
  return splitLines(oldText)
    .map((line) => normalizeLineForMatch(line.text))
    .filter((line) => line.trim().length > 0);
}

function findNormalizedLineMatches(content: string, oldText: string): Array<{ start: number; end: number }> {
  const contentLines = splitLines(content);
  const searchable = nonBlankLines(contentLines);
  const oldLines = normalizedOldNonBlankLines(oldText);
  if (oldLines.length === 0) return [];

  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i <= searchable.length - oldLines.length; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (searchable[i + j].normalized !== oldLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const first = contentLines[searchable[i].lineIndex];
      const last = contentLines[searchable[i + oldLines.length - 1].lineIndex];
      matches.push({ start: first.start, end: last.endNoNewline });
    }
  }
  return matches;
}

function summarizeOldText(oldText: string): string {
  const firstLine = normalizeToLF(oldText).split("\n").find((line) => line.trim().length > 0) ?? oldText;
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
}

function findBestLineHint(content: string, oldText: string): string | undefined {
  const oldLines = normalizedOldNonBlankLines(oldText);
  if (oldLines.length === 0) return undefined;
  const contentLines = nonBlankLines(splitLines(content));

  let best: { index: number; score: number } | undefined;
  for (let i = 0; i < contentLines.length; i++) {
    let score = 0;
    for (let j = 0; j < oldLines.length && i + j < contentLines.length; j++) {
      if (contentLines[i + j].normalized === oldLines[j]) score++;
    }
    if (!best || score > best.score) best = { index: i, score };
  }

  if (!best || best.score === 0) return undefined;
  const startLine = contentLines[best.index].lineIndex + 1;
  return `Closest line-based candidate starts near line ${startLine} and matched ${best.score}/${oldLines.length} non-blank lines.`;
}

function matchEdit(content: string, edit: EditOperation, index: number, total: number): EditMatchInfo {
  if (edit.oldText.length === 0) {
    throw new EditApplyError(total === 1 ? "Error: oldText must not be empty." : `Error: edits[${index}].oldText must not be empty.`);
  }

  if (edit.oldText === edit.newText) {
    const header = total === 1
      ? "Error: This edit is a no-op because oldText and newText are byte-identical."
      : `Error: edits[${index}] is a no-op because oldText and newText are byte-identical.`;
    throw new EditApplyError(
      [
        header,
        "",
        "Common causes and how to escape:",
        "- Your tokenizer may be folding repeated characters into a single token (hex colors like '#ec489' vs '#ec4899', repeated digits, etc.). The two strings feel different in your head but serialize to identical bytes.",
        "- Use the write tool with overwrite=true and the full new content for full-file replacements that hinge on a single repeated character or trailing digit.",
        "- Or re-read the file with the read tool, then copy the exact bytes you want to replace before retrying.",
      ].join("\n"),
    );
  }

  const oldText = normalizeToLF(edit.oldText);
  const exact = findAllOccurrences(content, oldText);
  if (exact.length === 1) {
    return { editIndex: index, mode: "exact", start: exact[0], end: exact[0] + oldText.length };
  }
  if (exact.length > 1) {
    const recovery = [
      "",
      "Extend oldText with more surrounding context (the lines immediately before/after) until it uniquely identifies the intended span.",
    ].join("\n");
    throw new EditApplyError(
      total === 1
        ? `Error: oldText appears ${exact.length} times in file. Must be unique: "${summarizeOldText(oldText)}"${recovery}`
        : `Error: edits[${index}].oldText appears ${exact.length} times in file. Must be unique: "${summarizeOldText(oldText)}"${recovery}`,
    );
  }

  const normalizedLineMatches = findNormalizedLineMatches(content, oldText);
  if (normalizedLineMatches.length === 1) {
    return {
      editIndex: index,
      mode: "normalized-line",
      start: normalizedLineMatches[0].start,
      end: normalizedLineMatches[0].end,
    };
  }
  if (normalizedLineMatches.length > 1) {
    throw new EditApplyError(
      total === 1
        ? `Error: oldText matched ${normalizedLineMatches.length} normalized line blocks in file. Provide more surrounding context.`
        : `Error: edits[${index}].oldText matched ${normalizedLineMatches.length} normalized line blocks in file. Provide more surrounding context.`,
    );
  }

  const hint = findBestLineHint(content, oldText);
  const hintSuffix = hint ? `\n${hint}` : "";
  const recovery = [
    "",
    "How to recover:",
    "- Re-read the file with the read tool to see its current bytes; the file may have been changed by a prior edit this turn.",
    "- Shorten oldText to a smaller unique anchor and try again. Long multi-line anchors are fragile to whitespace and indentation.",
    "- If many lines need to change, use the write tool with overwrite=true and the full new content instead of stacking edits.",
  ].join("\n");
  throw new EditApplyError(
    total === 1
      ? `Error: oldText not found in file: "${summarizeOldText(oldText)}"${hintSuffix}${recovery}`
      : `Error: edits[${index}].oldText not found in file: "${summarizeOldText(oldText)}"${hintSuffix}${recovery}`,
  );
}

function assertNoOverlaps(matches: EditMatchInfo[]): void {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous.end > current.start) {
      throw new EditApplyError(
        `Error: edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in file. Merge them into one edit or target disjoint regions.`,
        "blocked",
      );
    }
  }
}

export function applyEditsToContent(rawContent: string, edits: EditOperation[]): AppliedEditResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new EditApplyError("Error: No edits provided");
  }

  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const normalizedOriginal = normalizeToLF(text);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  const matches = normalizedEdits.map((edit, index) => matchEdit(normalizedOriginal, edit, index, normalizedEdits.length));
  assertNoOverlaps(matches);

  const byDescendingStart = [...matches].sort((a, b) => b.start - a.start);
  let normalizedNext = normalizedOriginal;
  for (const match of byDescendingStart) {
    const edit = normalizedEdits[match.editIndex];
    normalizedNext = normalizedNext.slice(0, match.start) + edit.newText + normalizedNext.slice(match.end);
  }

  if (normalizedNext === normalizedOriginal) {
    throw new EditApplyError(
      [
        "Error: No changes made. The replacement produced identical content.",
        "",
        "Common causes and how to escape:",
        "- oldText and newText are byte-identical. Verify newText actually contains the intended change (a missing trailing char like turning '#ec489' into '#ec4899' is a frequent culprit).",
        "- The file already contains newText. Re-read the file to confirm the current state before editing again.",
        "- For wholesale rewrites, use the write tool with overwrite=true and the full new content instead.",
      ].join("\n"),
    );
  }

  return {
    content: bom + restoreLineEndings(normalizedNext, lineEnding),
    normalizedOriginal,
    normalizedNext,
    bom,
    lineEnding,
    matches,
  };
}

export function formatEditMatchNotes(matches: EditMatchInfo[]): string {
  const normalizedCount = matches.filter((match) => match.mode !== "exact").length;
  if (normalizedCount === 0) return "";
  return `\n\nNote: ${normalizedCount} edit${normalizedCount === 1 ? "" : "s"} applied using normalized line matching for whitespace/formatting differences.`;
}

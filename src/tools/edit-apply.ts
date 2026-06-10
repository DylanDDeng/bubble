import { isSensitivePath } from "./sensitive-paths.js";

export interface EditOperation {
  oldText: string;
  newText: string;
}

export type EditMatchMode =
  | "exact"
  | "trimmed"
  | "unescaped"
  | "normalized-line"
  | "smart-line"
  | "markdown-table"
  | "single-line-whitespace";

export interface EditApplyOptions {
  path?: string;
}

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

interface TextCandidate {
  text: string;
  mode: EditMatchMode;
}

interface BestLineHint {
  startLine: number;
  score: number;
  total: number;
  lineIndex: number;
  tieCount: number;
}

const CANDIDATE_EXCERPT_CONTEXT_LINES = 3;
const CANDIDATE_EXCERPT_MAX_LINES = 8;
const CANDIDATE_EXCERPT_MAX_CHARS = 1200;

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

function unescapeOverEscaped(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\f/g, "\f")
    .replace(/\\b/g, "\b")
    .replace(/\\v/g, "\v")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function addTextCandidate(candidates: TextCandidate[], seen: Set<string>, text: string, mode: EditMatchMode): void {
  if (text.length === 0 || seen.has(text)) return;
  seen.add(text);
  candidates.push({ text, mode });
}

function generateTextCandidates(oldText: string): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  const seen = new Set<string>();
  const trimmed = oldText.trim();
  const unescaped = normalizeToLF(unescapeOverEscaped(oldText));
  const unescapedTrimmed = normalizeToLF(unescapeOverEscaped(trimmed));

  addTextCandidate(candidates, seen, oldText, "exact");
  addTextCandidate(candidates, seen, trimmed, "trimmed");
  addTextCandidate(candidates, seen, unescaped, "unescaped");
  addTextCandidate(candidates, seen, unescapedTrimmed, "unescaped");

  return candidates;
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

function normalizeLeadingWhitespaceForMatch(line: string): string {
  return normalizeLineForMatch(line).replace(/^\s+/, " ");
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

function singleNonBlankOldLine(oldText: string): string | undefined {
  const lines = normalizedOldNonBlankLines(oldText);
  return lines.length === 1 ? lines[0] : undefined;
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

function findSmartLineMatches(content: string, oldText: string): Array<{ start: number; end: number }> {
  const contentLines = splitLines(content);
  const oldLines = splitLines(oldText).map((line) => normalizeLeadingWhitespaceForMatch(line.text));
  if (oldLines.length === 0 || oldLines.every((line) => line.length === 0)) return [];

  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      const actual = normalizeLeadingWhitespaceForMatch(contentLines[i + j].text);
      if (actual !== oldLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const first = contentLines[i];
      const last = contentLines[i + oldLines.length - 1];
      matches.push({ start: first.start, end: last.endNoNewline });
    }
  }
  return matches;
}

function splitMarkdownTableCells(line: string): string[] | undefined {
  const normalized = normalizeLineForMatch(line).trim();
  if (!normalized.startsWith("|") || !normalized.endsWith("|")) return undefined;

  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of normalized) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  if (parts.length < 4 || parts[0] !== "" || parts[parts.length - 1] !== "") return undefined;
  const cells = parts.slice(1, -1).map((cell) => cell.trim());
  return cells.length >= 2 ? cells : undefined;
}

function sameCells(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((cell, index) => cell === b[index]);
}

function findMarkdownTableMatches(content: string, oldText: string): Array<{ start: number; end: number }> {
  const oldLine = singleNonBlankOldLine(oldText);
  if (!oldLine) return [];
  const oldCells = splitMarkdownTableCells(oldLine);
  if (!oldCells) return [];

  const matches: Array<{ start: number; end: number }> = [];
  for (const line of splitLines(content)) {
    const cells = splitMarkdownTableCells(line.text);
    if (cells && sameCells(cells, oldCells)) {
      matches.push({ start: line.start, end: line.endNoNewline });
    }
  }
  return matches;
}

function collapseInlineWhitespace(text: string): string {
  return normalizeLineForMatch(text).trim().replace(/[ \t]+/g, " ");
}

function isDocumentLikePath(path: string | undefined): boolean {
  return !!path && /\.(?:md|mdx|markdown|txt|rst|adoc)$/i.test(path);
}

function findSingleLineWhitespaceMatches(
  content: string,
  oldText: string,
  options: EditApplyOptions | undefined,
): Array<{ start: number; end: number }> {
  if (!isDocumentLikePath(options?.path)) return [];

  const oldLine = singleNonBlankOldLine(oldText);
  if (!oldLine) return [];
  const normalizedOld = collapseInlineWhitespace(oldLine);
  if (normalizedOld.length === 0) return [];

  const matches: Array<{ start: number; end: number }> = [];
  for (const line of splitLines(content)) {
    const collapsed = collapseInlineWhitespace(line.text);
    if (collapsed === normalizedOld && line.text !== oldLine) {
      matches.push({ start: line.start, end: line.endNoNewline });
    }
  }
  return matches;
}

function summarizeOldText(oldText: string): string {
  const firstLine = normalizeToLF(oldText).split("\n").find((line) => line.trim().length > 0) ?? oldText;
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
}

function findBestLineHint(content: string, oldText: string): BestLineHint | undefined {
  const oldLines = normalizedOldNonBlankLines(oldText);
  if (oldLines.length === 0) return undefined;
  const contentLines = nonBlankLines(splitLines(content));

  let best: { index: number; score: number } | undefined;
  let tieCount = 0;
  for (let i = 0; i < contentLines.length; i++) {
    let score = 0;
    for (let j = 0; j < oldLines.length && i + j < contentLines.length; j++) {
      if (contentLines[i + j].normalized === oldLines[j]) score++;
    }
    if (!best || score > best.score) {
      best = { index: i, score };
      tieCount = 1;
    } else if (score === best.score) {
      tieCount++;
    }
  }

  if (!best || best.score === 0) return undefined;
  const startLine = contentLines[best.index].lineIndex + 1;
  return {
    startLine,
    score: best.score,
    total: oldLines.length,
    lineIndex: contentLines[best.index].lineIndex,
    tieCount,
  };
}

function isHighConfidenceLineHint(hint: BestLineHint): boolean {
  return hint.score >= 2 && hint.score / hint.total >= 0.5 && hint.tieCount === 1;
}

function formatLineHint(hint: BestLineHint): string {
  if (hint.tieCount > 1) {
    return `Closest ambiguous line-based candidate starts near line ${hint.startLine} and matched ${hint.score}/${hint.total} non-blank lines, but ${hint.tieCount} candidates tied. Current bytes were not included because the candidate may be unrelated.`;
  }
  if (!isHighConfidenceLineHint(hint)) {
    return `Closest low-confidence line-based candidate starts near line ${hint.startLine} and matched ${hint.score}/${hint.total} non-blank lines. Current bytes were not included because the candidate may be unrelated.`;
  }
  return `Closest line-based candidate starts near line ${hint.startLine} and matched ${hint.score}/${hint.total} non-blank lines.`;
}

function formatFence(content: string): string {
  let fence = "```";
  while (content.includes(fence)) fence += "`";
  return `${fence}\n${content}\n${fence}`;
}

function truncateExcerpt(excerpt: string): string {
  if (excerpt.length <= CANDIDATE_EXCERPT_MAX_CHARS) return excerpt;
  const marker = "\n...[truncated current candidate excerpt]";
  return excerpt.slice(0, Math.max(0, CANDIDATE_EXCERPT_MAX_CHARS - marker.length)) + marker;
}

function formatCandidateExcerpt(content: string, hint: BestLineHint): string {
  const lines = splitLines(content);
  const startLineIndex = Math.max(0, hint.lineIndex - CANDIDATE_EXCERPT_CONTEXT_LINES);
  const requestedEnd = Math.min(lines.length, hint.lineIndex + CANDIDATE_EXCERPT_CONTEXT_LINES + 1);
  const endLineIndex = Math.min(requestedEnd, startLineIndex + CANDIDATE_EXCERPT_MAX_LINES);
  const excerpt = truncateExcerpt(lines.slice(startLineIndex, endLineIndex).map((line) => line.text).join("\n"));
  return [
    `Current candidate excerpt (high confidence, current file lines ${startLineIndex + 1}-${endLineIndex}, not guaranteed target):`,
    formatFence(excerpt),
  ].join("\n");
}

function formatBestLineHint(content: string, hint: BestLineHint, options?: EditApplyOptions): string {
  const lineHint = formatLineHint(hint);
  if (!isHighConfidenceLineHint(hint)) return lineHint;
  if (options?.path && isSensitivePath(options.path)) {
    return `${lineHint}\nCurrent bytes were not included because this path is blocked by the sensitive-path read policy.`;
  }
  return `${lineHint}\n\n${formatCandidateExcerpt(content, hint)}`;
}

function matchEdit(
  content: string,
  edit: EditOperation,
  index: number,
  total: number,
  options?: EditApplyOptions,
): EditMatchInfo {
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
        "- Use the write tool with the full new content for full-file replacements that hinge on a single repeated character or trailing digit.",
        "- Or re-read the file with the read tool, then copy the exact bytes you want to replace before retrying.",
      ].join("\n"),
    );
  }

  const oldText = normalizeToLF(edit.oldText);
  const candidates = generateTextCandidates(oldText);

  for (const candidate of candidates) {
    const exact = findAllOccurrences(content, candidate.text);
    if (exact.length === 1) {
      return { editIndex: index, mode: candidate.mode, start: exact[0], end: exact[0] + candidate.text.length };
    }
    if (exact.length > 1) {
      const recovery = [
        "",
        "Extend oldText with more surrounding context (the lines immediately before/after) until it uniquely identifies the intended span.",
      ].join("\n");
      const duplicateReason = candidate.mode === "exact"
        ? `appears ${exact.length} times in file`
        : `matched ${exact.length} times after ${candidate.mode} matching`;
      throw new EditApplyError(
        total === 1
          ? `Error: oldText ${duplicateReason}. Must be unique: "${summarizeOldText(oldText)}"${recovery}`
          : `Error: edits[${index}].oldText ${duplicateReason}. Must be unique: "${summarizeOldText(oldText)}"${recovery}`,
      );
    }
  }

  for (const candidate of candidates) {
    const normalizedLineMatches = findNormalizedLineMatches(content, candidate.text);
    if (normalizedLineMatches.length === 1) {
      return {
        editIndex: index,
        mode: candidate.mode === "exact" ? "normalized-line" : candidate.mode,
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
  }

  for (const candidate of candidates) {
    const markdownTableMatches = findMarkdownTableMatches(content, candidate.text);
    if (markdownTableMatches.length === 1) {
      return {
        editIndex: index,
        mode: "markdown-table",
        start: markdownTableMatches[0].start,
        end: markdownTableMatches[0].end,
      };
    }
    if (markdownTableMatches.length > 1) {
      throw new EditApplyError(
        total === 1
          ? `Error: oldText matched ${markdownTableMatches.length} markdown table rows in file. Provide more surrounding context.`
          : `Error: edits[${index}].oldText matched ${markdownTableMatches.length} markdown table rows in file. Provide more surrounding context.`,
      );
    }
  }

  for (const candidate of candidates) {
    const whitespaceMatches = findSingleLineWhitespaceMatches(content, candidate.text, options);
    if (whitespaceMatches.length === 1) {
      return {
        editIndex: index,
        mode: "single-line-whitespace",
        start: whitespaceMatches[0].start,
        end: whitespaceMatches[0].end,
      };
    }
    if (whitespaceMatches.length > 1) {
      throw new EditApplyError(
        total === 1
          ? `Error: oldText matched ${whitespaceMatches.length} whitespace-normalized lines in file. Provide more surrounding context.`
          : `Error: edits[${index}].oldText matched ${whitespaceMatches.length} whitespace-normalized lines in file. Provide more surrounding context.`,
      );
    }
  }

  for (const candidate of candidates) {
    const smartLineMatches = findSmartLineMatches(content, candidate.text);
    if (smartLineMatches.length === 1) {
      return {
        editIndex: index,
        mode: "smart-line",
        start: smartLineMatches[0].start,
        end: smartLineMatches[0].end,
      };
    }
    if (smartLineMatches.length > 1) {
      throw new EditApplyError(
        total === 1
          ? `Error: oldText matched ${smartLineMatches.length} indentation-normalized line blocks in file. Provide more surrounding context.`
          : `Error: edits[${index}].oldText matched ${smartLineMatches.length} indentation-normalized line blocks in file. Provide more surrounding context.`,
      );
    }
  }

  const hint = findBestLineHint(content, oldText);
  const hintSuffix = hint ? `\n${formatBestLineHint(content, hint, options)}` : "";
  const recovery = [
    "",
    "How to recover:",
    "- Re-read the file with the read tool to see its current bytes; the file may have been changed by a prior edit this turn.",
    "- Shorten oldText to a smaller unique anchor and try again. Long multi-line anchors are fragile to whitespace and indentation.",
    "- If many lines need to change, use the write tool with the full new content instead of stacking edits.",
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

export function applyEditsToContent(rawContent: string, edits: EditOperation[], options?: EditApplyOptions): AppliedEditResult {
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

  const matches = normalizedEdits.map((edit, index) => matchEdit(normalizedOriginal, edit, index, normalizedEdits.length, options));
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
        "- For wholesale rewrites, use the write tool with the full new content instead.",
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

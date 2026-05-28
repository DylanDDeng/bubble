export type PatchFileOperation =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

export interface PatchChunk {
  header: string;
  lines: PatchLine[];
}

export type PatchLine =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

export interface ParsedApplyPatch {
  operations: PatchFileOperation[];
}

export interface PatchedContentResult {
  content: string;
  usedFallback: boolean;
}

export class PatchApplyError extends Error {
  constructor(
    message: string,
    readonly status: "no_match" | "blocked" = "no_match",
  ) {
    super(message);
    this.name = "PatchApplyError";
  }
}

interface LineInfo {
  text: string;
  start: number;
  endNoNewline: number;
}

const CHANGE_MARKERS = [
  "*** Add File: ",
  "*** Delete File: ",
  "*** Update File: ",
  "*** End Patch",
];

export function parseApplyPatch(patchText: string): ParsedApplyPatch {
  const lines = normalizeToLF(patchText).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== "*** Begin Patch") {
    throw new PatchApplyError("Error: apply_patch must start with *** Begin Patch", "blocked");
  }

  const operations: PatchFileOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      if (index !== lines.length - 1) {
        throw new PatchApplyError("Error: Unexpected content after *** End Patch", "blocked");
      }
      if (operations.length === 0) {
        throw new PatchApplyError("Error: apply_patch rejected an empty patch", "blocked");
      }
      return { operations };
    }

    if (line.startsWith("*** Add File: ")) {
      const path = parseMarkerPath(line, "*** Add File: ");
      index++;
      const addLines: string[] = [];
      while (index < lines.length && !isFileMarker(lines[index])) {
        const current = lines[index];
        if (!current.startsWith("+")) {
          throw new PatchApplyError(`Error: Add File ${path} contains a non-added line: ${current}`, "blocked");
        }
        addLines.push(current.slice(1));
        index++;
      }
      operations.push({ type: "add", path, lines: addLines });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const path = parseMarkerPath(line, "*** Delete File: ");
      operations.push({ type: "delete", path });
      index++;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = parseMarkerPath(line, "*** Update File: ");
      index++;
      let movePath: string | undefined;
      const chunks: PatchChunk[] = [];

      while (index < lines.length && !isFileMarker(lines[index])) {
        const current = lines[index];
        if (current.startsWith("*** Move to: ")) {
          if (movePath || chunks.length > 0) {
            throw new PatchApplyError(`Error: Move marker for ${path} must appear before update chunks`, "blocked");
          }
          movePath = parseMarkerPath(current, "*** Move to: ");
          index++;
          continue;
        }

        if (!current.startsWith("@@")) {
          throw new PatchApplyError(`Error: Update File ${path} expected @@ hunk header, got: ${current}`, "blocked");
        }

        const header = current;
        index++;
        const chunkLines: PatchLine[] = [];
        while (index < lines.length && !isFileMarker(lines[index]) && !lines[index].startsWith("@@")) {
          const patchLine = lines[index];
          if (patchLine.startsWith("\\ No newline at end of file")) {
            index++;
            continue;
          }
          const prefix = patchLine[0];
          const text = patchLine.slice(1);
          if (prefix === " ") {
            chunkLines.push({ kind: "context", text });
          } else if (prefix === "-") {
            chunkLines.push({ kind: "remove", text });
          } else if (prefix === "+") {
            chunkLines.push({ kind: "add", text });
          } else {
            throw new PatchApplyError(`Error: Hunk for ${path} contains invalid line: ${patchLine}`, "blocked");
          }
          index++;
        }
        if (chunkLines.length === 0) {
          throw new PatchApplyError(`Error: Empty hunk in ${path}`, "blocked");
        }
        chunks.push({ header, lines: chunkLines });
      }

      if (!movePath && chunks.length === 0) {
        throw new PatchApplyError(`Error: Update File ${path} has no hunks`, "blocked");
      }
      operations.push({ type: "update", path, ...(movePath ? { movePath } : {}), chunks });
      continue;
    }

    throw new PatchApplyError(`Error: Unexpected patch marker: ${line}`, "blocked");
  }

  throw new PatchApplyError("Error: apply_patch must end with *** End Patch", "blocked");
}

export function buildAddedFileContent(lines: string[]): string {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

export function applyPatchChunks(rawContent: string, chunks: PatchChunk[], path: string): PatchedContentResult {
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  let normalized = normalizeToLF(text);
  let usedFallback = false;

  for (let index = 0; index < chunks.length; index++) {
    const result = applyChunk(normalized, chunks[index], path, index);
    normalized = result.content;
    usedFallback ||= result.usedFallback;
  }

  return {
    content: bom + restoreLineEndings(normalized, lineEnding),
    usedFallback,
  };
}

function applyChunk(content: string, chunk: PatchChunk, path: string, chunkIndex: number): PatchedContentResult {
  const oldLines = chunk.lines
    .filter((line) => line.kind === "context" || line.kind === "remove")
    .map((line) => line.text);
  const newLines = chunk.lines
    .filter((line) => line.kind === "context" || line.kind === "add")
    .map((line) => line.text);

  if (oldLines.length === 0) {
    throw new PatchApplyError(`Error: Hunk ${chunkIndex + 1} in ${path} has no context to locate an insertion.`, "blocked");
  }

  const exactMatches = findExactLineBlockMatches(content, oldLines);
  if (exactMatches.length === 1) {
    return {
      content: replaceSpan(content, exactMatches[0], newLines),
      usedFallback: false,
    };
  }
  if (exactMatches.length > 1) {
    throw new PatchApplyError(`Error: Hunk ${chunkIndex + 1} in ${path} matched ${exactMatches.length} exact locations. Add more context.`, "blocked");
  }

  const fallbackMatches = findNormalizedLineBlockMatches(content, oldLines, path);
  if (fallbackMatches.length === 1) {
    return {
      content: replaceSpan(content, fallbackMatches[0], newLines),
      usedFallback: true,
    };
  }
  if (fallbackMatches.length > 1) {
    throw new PatchApplyError(`Error: Hunk ${chunkIndex + 1} in ${path} matched ${fallbackMatches.length} normalized locations. Add more context.`, "blocked");
  }

  throw new PatchApplyError(`Error: Hunk ${chunkIndex + 1} in ${path} did not match the file. Re-read the file and regenerate the patch.`);
}

function parseMarkerPath(line: string, marker: string): string {
  const path = line.slice(marker.length).trim();
  if (!path) throw new PatchApplyError(`Error: Patch marker is missing a path: ${line}`, "blocked");
  return path;
}

function isFileMarker(line: string): boolean {
  return CHANGE_MARKERS.some((marker) => line === marker || line.startsWith(marker));
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

function splitLines(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") {
      lines.push({ text: content.slice(start, index), start, endNoNewline: index });
      start = index + 1;
    }
  }
  lines.push({ text: content.slice(start), start, endNoNewline: content.length });
  return lines;
}

function findExactLineBlockMatches(content: string, oldLines: string[]): Array<{ start: number; end: number }> {
  const lines = splitLines(content);
  const matches: Array<{ start: number; end: number }> = [];
  for (let index = 0; index <= lines.length - oldLines.length; index++) {
    let matched = true;
    for (let offset = 0; offset < oldLines.length; offset++) {
      if (lines[index + offset].text !== oldLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push({
        start: lines[index].start,
        end: lines[index + oldLines.length - 1].endNoNewline,
      });
    }
  }
  return matches;
}

function findNormalizedLineBlockMatches(content: string, oldLines: string[], path: string): Array<{ start: number; end: number }> {
  const expected = oldLines
    .map((line) => normalizeLineForMatch(line))
    .filter((line) => line.trim().length > 0);
  if (expected.length === 0) return [];

  const contentLines = splitLines(content)
    .map((line) => ({ line, normalized: normalizeLineForMatch(line.text) }))
    .filter((item) => item.normalized.trim().length > 0);

  const matches: Array<{ start: number; end: number }> = [];
  for (let index = 0; index <= contentLines.length - expected.length; index++) {
    let matched = true;
    for (let offset = 0; offset < expected.length; offset++) {
      if (!lineEquivalent(contentLines[index + offset].line.text, expected[offset], path, expected.length)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push({
        start: contentLines[index].line.start,
        end: contentLines[index + expected.length - 1].line.endNoNewline,
      });
    }
  }
  return matches;
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

function lineEquivalent(actual: string, expectedNormalized: string, path: string, expectedLineCount: number): boolean {
  const actualNormalized = normalizeLineForMatch(actual);
  if (actualNormalized === expectedNormalized) return true;

  const actualCells = splitMarkdownTableCells(actualNormalized);
  const expectedCells = splitMarkdownTableCells(expectedNormalized);
  if (actualCells && expectedCells && sameCells(actualCells, expectedCells)) return true;

  if (expectedLineCount === 1 && isDocumentLikePath(path)) {
    return collapseInlineWhitespace(actualNormalized) === collapseInlineWhitespace(expectedNormalized);
  }

  return false;
}

function splitMarkdownTableCells(line: string): string[] | undefined {
  const normalized = line.trim();
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

function collapseInlineWhitespace(text: string): string {
  return text.trim().replace(/[ \t]+/g, " ");
}

function isDocumentLikePath(path: string): boolean {
  return /\.(?:md|mdx|markdown|txt|rst|adoc)$/i.test(path);
}

function replaceSpan(content: string, span: { start: number; end: number }, newLines: string[]): string {
  return content.slice(0, span.start) + newLines.join("\n") + content.slice(span.end);
}

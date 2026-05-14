/**
 * Lightweight Markdown renderer for Ink TUI.
 * Supports code blocks, inline formatting, and tables.
 */

import React from "react";
import { Box, Text } from "ink";
import { useTerminalSize } from "./use-terminal-size.js";
import { theme } from "./theme.js";
import { highlightCode } from "./code-highlight.js";

export type MarkdownBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; lines: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

export interface MarkdownInlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang, lines: codeLines });
      i++;
      continue;
    }

    // Table
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const headers = parseTableRow(tableLines[0]);
        if (headers.length > 0 && isTableSeparatorRow(tableLines[1], headers.length)) {
          const rows = tableLines.slice(2).map((rowLine) => normalizeTableRow(parseTableRow(rowLine), headers.length));
          blocks.push({ type: "table", headers, rows });
        } else {
          blocks.push({ type: "paragraph", lines: tableLines });
        }
      } else {
        blocks.push({ type: "paragraph", lines: tableLines });
      }
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
      i++;
      continue;
    }

    // Empty line -> skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].trim().startsWith("|")
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", lines: paraLines });
  }

  return blocks;
}

function parseTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (endsWithUnescapedPipe(body)) body = body.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === "\\" && i + 1 < body.length) {
      current += body[i + 1]!;
      i++;
      continue;
    }
    if (char === "`") {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function endsWithUnescapedPipe(text: string): boolean {
  if (!text.endsWith("|")) return false;
  let slashCount = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 0;
}

function isTableSeparatorRow(line: string, expectedColumns: number): boolean {
  const cells = parseTableRow(line);
  if (cells.length !== expectedColumns) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function normalizeTableRow(row: string[], colCount: number): string[] {
  const normalized = row.slice(0, colCount);
  while (normalized.length < colCount) normalized.push("");
  return normalized;
}

function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) width += charVisualWidth(char);
  return width;
}

// Inline formatting: bold, italic, inline code
export function parseMarkdownInlineSegments(text: string, style: InlineStyle = {}): MarkdownInlineSegment[] {
  const segments: MarkdownInlineSegment[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    appendInlineSegment(segments, buffer, style);
    buffer = "";
  };

  while (i < text.length) {
    const char = text[i]!;
    if (char === "\\" && i + 1 < text.length) {
      buffer += text[i + 1]!;
      i += 2;
      continue;
    }

    if (char === "`") {
      const close = findClosingMarker(text, "`", i + 1);
      if (close !== -1) {
        flush();
        appendInlineSegment(segments, text.slice(i + 1, close), { ...style, code: true });
        i = close + 1;
        continue;
      }
    }

    const marker = inlineMarkerAt(text, i);
    if (marker) {
      const close = findClosingMarker(text, marker, i + marker.length);
      if (close !== -1 && close > i + marker.length) {
        flush();
        const inner = text.slice(i + marker.length, close);
        const nextStyle = marker === "***"
          ? { ...style, bold: true, italic: true }
          : marker === "**" || marker === "__"
            ? { ...style, bold: true }
            : { ...style, italic: true };
        for (const segment of parseMarkdownInlineSegments(inner, nextStyle)) {
          appendInlineSegment(segments, segment.text, segment);
        }
        i = close + marker.length;
        continue;
      }
    }

    buffer += char;
    i++;
  }

  flush();
  return segments.length > 0 ? segments : [{ text, ...style }];
}

function inlineMarkerAt(text: string, index: number): string | null {
  for (const marker of ["***", "**", "__", "*", "_"]) {
    if (!text.startsWith(marker, index)) continue;
    if (marker.includes("_") && isIntraWordUnderscore(text, index, marker.length)) continue;
    return marker;
  }
  return null;
}

function findClosingMarker(text: string, marker: string, start: number): number {
  for (let i = start; i <= text.length - marker.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (!text.startsWith(marker, i)) continue;
    if (marker.includes("_") && isIntraWordUnderscore(text, i, marker.length)) continue;
    return i;
  }
  return -1;
}

function isIntraWordUnderscore(text: string, index: number, markerLength: number): boolean {
  const before = text[index - 1];
  const after = text[index + markerLength];
  return isWordChar(before) && isWordChar(after);
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9]/.test(char);
}

function appendInlineSegment(
  segments: MarkdownInlineSegment[],
  text: string,
  style: InlineStyle,
) {
  if (!text) return;
  const previous = segments[segments.length - 1];
  const next = {
    text,
    bold: style.bold || undefined,
    italic: style.italic || undefined,
    code: style.code || undefined,
  };
  if (
    previous &&
    previous.bold === next.bold &&
    previous.italic === next.italic &&
    previous.code === next.code
  ) {
    previous.text += text;
  } else {
    segments.push(next);
  }
}

function renderInlineSegments(
  text: string,
  keyPrefix: string,
  style: InlineStyle = {},
): React.ReactNode[] {
  return parseMarkdownInlineSegments(text, style).map((segment, index) => (
    <Text
      key={`${keyPrefix}-${index}`}
      bold={segment.bold}
      italic={segment.italic}
      color={segment.code ? "#a78bfa" : undefined}
    >
      {segment.text}
    </Text>
  ));
}

function inlinePlainText(text: string): string {
  return parseMarkdownInlineSegments(text).map((segment) => segment.text).join("");
}

function InlineText({ text }: { text: string }) {
  return <Text>{renderInlineSegments(text, "inline")}</Text>;
}

function CodeBlock({ lang, lines }: { lang: string; lines: string[] }) {
  const [highlighted, setHighlighted] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function run() {
      const code = lines.join("\n");
      if (!code) return;
      try {
        const ansi = await highlightCode(code, lang || "text");
        if (!cancelled) setHighlighted(ansi.split("\n"));
      } catch {
        if (!cancelled) setHighlighted(lines);
      }
    }
    // Show plain text immediately while highlighting loads
    setHighlighted(lines);
    run();
    return () => {
      cancelled = true;
    };
  }, [lang, lines]);

  return (
    <Box flexDirection="column" marginY={1}>
      {lang && <Text color={theme.muted}>{lang}</Text>}
      <Box flexDirection="column">
        {highlighted?.map((line, i) => (
          <Text key={i}>{line || " "}</Text>
        ))}
      </Box>
    </Box>
  );
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const { columns: termWidth } = useTerminalSize();
  const colCount = headers.length;

  const maxWidths = headers.map((h, i) => {
    let max = visualWidth(inlinePlainText(h));
    for (const row of rows) {
      const cell = row[i] || "";
      max = Math.max(max, visualWidth(inlinePlainText(cell)));
    }
    return max;
  });

  const totalInnerWidth = maxWidths.reduce((a, b) => a + b, 0);
  const totalWidth = totalInnerWidth + colCount * 3 + 1; // " │ " separators + outer edges

  let widths = [...maxWidths];
  if (totalWidth > termWidth - 4) {
    const available = Math.max(termWidth - 4 - (colCount * 3 + 1), colCount * 4);
    const ratio = totalInnerWidth > 0 ? available / totalInnerWidth : 1;
    widths = maxWidths.map((w) => Math.max(4, Math.floor(w * ratio)));
  }

  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const mid = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  const renderRow = (cells: string[], isHeader = false) => (
    <Text>
      {"│ "}
      {cells.map((c, i) => (
        <React.Fragment key={i}>
          {renderTableCell(c, widths[i] ?? 4, isHeader, `cell-${i}`)}
          {i < colCount - 1 ? " │ " : " │"}
        </React.Fragment>
      ))}
    </Text>
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <Text>{top}</Text>
      {renderRow(headers, true)}
      <Text>{mid}</Text>
      {rows.map((row, ri) => (
        <Box key={ri}>{renderRow(row)}</Box>
      ))}
      <Text>{bot}</Text>
    </Box>
  );
}

function renderTableCell(
  cell: string,
  width: number,
  isHeader: boolean,
  keyPrefix: string,
): React.ReactNode[] {
  const segments = truncateInlineSegments(parseMarkdownInlineSegments(cell, { bold: isHeader }), width);
  const padding = " ".repeat(Math.max(0, width - inlineSegmentsWidth(segments)));
  return [
    ...segments.map((segment, index) => (
      <Text
        key={`${keyPrefix}-${index}`}
        bold={segment.bold}
        italic={segment.italic}
        color={segment.code ? "#a78bfa" : undefined}
      >
        {segment.text}
      </Text>
    )),
    <Text key={`${keyPrefix}-pad`}>{padding}</Text>,
  ];
}

function truncateInlineSegments(
  segments: MarkdownInlineSegment[],
  width: number,
): MarkdownInlineSegment[] {
  if (inlineSegmentsWidth(segments) <= width) return segments;
  if (width <= 1) return [{ text: "…" }];
  const target = width - 1;
  const output: MarkdownInlineSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    let text = "";
    for (const char of segment.text) {
      const charWidth = charVisualWidth(char);
      if (used + charWidth > target) {
        appendInlineSegment(output, "…", {});
        return output;
      }
      text += char;
      used += charWidth;
    }
    appendInlineSegment(output, text, segment);
  }
  appendInlineSegment(output, "…", {});
  return output;
}

function inlineSegmentsWidth(segments: MarkdownInlineSegment[]): number {
  return segments.reduce((sum, segment) => sum + visualWidth(segment.text), 0);
}

function charVisualWidth(char: string): number {
  const code = char.codePointAt(0) || 0;
  if (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0xff00 && code <= 0xffef) || // Halfwidth and Fullwidth Forms
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) // Katakana
  ) {
    return 2;
  }
  return 1;
}

function HeadingBlock({ level, text }: { level: number; text: string }) {
  const props: any = { bold: true };
  if (level === 1) {
    props.underline = true;
    props.color = theme.accent;
  } else if (level === 2) {
    props.color = theme.accent;
  } else if (level === 3) {
    props.color = theme.warning;
  }
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text {...props}>{text}</Text>
    </Box>
  );
}

export function MarkdownContent({ content }: { content: string }) {
  const blocks = React.useMemo(() => parseMarkdownBlocks(content), [content]);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        if (block.type === "code") {
          return <CodeBlock key={i} lang={block.lang} lines={block.lines} />;
        }
        if (block.type === "table") {
          return <TableBlock key={i} headers={block.headers} rows={block.rows} />;
        }
        if (block.type === "heading") {
          return <HeadingBlock key={i} level={block.level} text={block.text} />;
        }
        return (
          <Box key={i} flexDirection="column" marginBottom={1}>
            {block.lines.map((line, li) => (
              <InlineText key={li} text={line} />
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

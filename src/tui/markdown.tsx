/**
 * Lightweight Markdown renderer for Ink TUI.
 * Supports code blocks, inline formatting, and tables.
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import { theme } from "./theme.js";
import { highlightCode } from "./code-highlight.js";

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "code"; lang: string; lines: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
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
        const rows = tableLines.slice(2).map(parseTableRow);
        // Pad rows to match header column count
        for (const row of rows) {
          while (row.length < headers.length) row.push("");
        }
        blocks.push({ type: "table", headers, rows });
      } else {
        blocks.push({ type: "paragraph", lines: tableLines });
      }
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
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
      (code >= 0xff00 && code <= 0xffef) || // Halfwidth and Fullwidth Forms
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) // Katakana
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padVisual(str: string, width: number): string {
  const w = visualWidth(str);
  return str + " ".repeat(Math.max(0, width - w));
}

// Inline formatting: bold, italic, inline code
function parseInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Text key={lastIndex}>{text.slice(lastIndex, match.index)}</Text>);
    }
    const content = match[2] || match[3] || match[4] || match[5] || match[6] || match[7];
    const marker = match[0];

    if (marker.startsWith("***")) {
      nodes.push(<Text key={match.index} bold italic>{content}</Text>);
    } else if (marker.startsWith("**") || marker.startsWith("__")) {
      nodes.push(<Text key={match.index} bold>{content}</Text>);
    } else if (marker.startsWith("*") || marker.startsWith("_")) {
      nodes.push(<Text key={match.index} italic>{content}</Text>);
    } else if (marker.startsWith("`")) {
      nodes.push(
        <Text key={match.index} color={theme.code} backgroundColor="gray">
          {" " + content + " "}
        </Text>
      );
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(<Text key={lastIndex}>{text.slice(lastIndex)}</Text>);
  }

  if (nodes.length === 0) {
    return [<Text key={0}>{text}</Text>];
  }
  return nodes;
}

function InlineText({ text }: { text: string }) {
  return <Text>{parseInline(text)}</Text>;
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
      <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
        {highlighted?.map((line, i) => (
          <Text key={i}>{line || " "}</Text>
        ))}
      </Box>
    </Box>
  );
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 80;
  const colCount = headers.length;

  const maxWidths = headers.map((h, i) => {
    let max = visualWidth(h);
    for (const row of rows) {
      const cell = row[i] || "";
      max = Math.max(max, visualWidth(cell));
    }
    return max;
  });

  const totalInnerWidth = maxWidths.reduce((a, b) => a + b, 0);
  const totalWidth = totalInnerWidth + (colCount + 1) * 3; // " │ " separators + outer edges

  let widths = [...maxWidths];
  if (totalWidth > termWidth - 4) {
    const available = Math.max(termWidth - 4 - (colCount + 1) * 3, colCount * 4);
    const ratio = available / totalInnerWidth;
    widths = maxWidths.map((w) => Math.max(4, Math.floor(w * ratio)));
  }

  const top = "┌─" + widths.map((w) => "─".repeat(w + 2)).join("┬─") + "┐";
  const mid = "├─" + widths.map((w) => "─".repeat(w + 2)).join("┼─") + "┤";
  const bot = "└─" + widths.map((w) => "─".repeat(w + 2)).join("┴─") + "┘";

  const renderRow = (cells: string[], isHeader = false) => (
    <Text>
      {"│ "}
      {cells.map((c, i) => (
        <React.Fragment key={i}>
          {isHeader ? <Text bold>{padVisual(c, widths[i])}</Text> : padVisual(c, widths[i])}
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

export function MarkdownContent({ content }: { content: string }) {
  const blocks = React.useMemo(() => parseBlocks(content), [content]);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        if (block.type === "code") {
          return <CodeBlock key={i} lang={block.lang} lines={block.lines} />;
        }
        if (block.type === "table") {
          return <TableBlock key={i} headers={block.headers} rows={block.rows} />;
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

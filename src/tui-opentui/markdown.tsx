/** @jsxImportSource @opentui/react */
/**
 * Markdown rendering for the OpenTUI-based TUI.
 *
 * The previous Ink implementation hand-parsed markdown into block primitives
 * because Ink had no native markdown support. OpenTUI ships
 * `MarkdownRenderable` as a built-in (tree-sitter backed), so most of the
 * 600+ lines of parsing logic collapse to a single intrinsic element.
 *
 * Public exports are kept compatible with the old Ink module so consumers
 * (message-list, plan-confirm) don't need import changes.
 */

import React from "react";
import { useTheme } from "./theme.js";

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

/**
 * Detect the byte offset where the last complete block ends. Used by the
 * streaming renderer to keep already-finalized blocks stable while the
 * trailing block is still being typed.
 */
export function findLastBlockStart(text: string): number {
  // Walk backwards to find the start of the trailing incomplete block.
  // A block break is a blank line (two newlines) at column 0. If we are
  // inside an unclosed ```/~~~ fence, the trailing block extends back to
  // the fence opener.
  const lastFenceOpen = findUnclosedFenceStart(text);
  if (lastFenceOpen !== -1) return lastFenceOpen;
  const idx = text.lastIndexOf("\n\n");
  return idx === -1 ? 0 : idx + 2;
}

function findUnclosedFenceStart(text: string): number {
  let cursor = 0;
  let openAt = -1;
  let openMarker: "`" | "~" | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/^ {0,3}/, "");
    if (openMarker === null) {
      if (trimmed.startsWith("```")) {
        openMarker = "`";
        openAt = cursor;
      } else if (trimmed.startsWith("~~~")) {
        openMarker = "~";
        openAt = cursor;
      }
    } else if (trimmed.startsWith(openMarker.repeat(3))) {
      openMarker = null;
      openAt = -1;
    }
    cursor += line.length + 1;
  }
  return openMarker === null ? -1 : openAt;
}

/** Stub kept for test compatibility — OpenTUI parses internally. */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      blocks.push({ type: "code", lang, lines: codeLines });
      i++;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const match = /^(#{1,6})\s+(.*)$/.exec(line);
      if (match) {
        blocks.push({ type: "heading", level: match[1]!.length, text: match[2]! });
        i++;
        continue;
      }
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```")) {
      paragraph.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}

/** Stub kept for test compatibility. */
export function parseMarkdownInlineSegments(
  text: string,
  style: { bold?: boolean; italic?: boolean; code?: boolean } = {},
): MarkdownInlineSegment[] {
  return [{ text, ...style }];
}

interface MarkdownProps {
  content: string;
  terminalColumns?: number;
}

/**
 * Render a complete (non-streaming) markdown blob. OpenTUI's MarkdownRenderable
 * handles parse + style + code highlighting via tree-sitter internally.
 */
export function MarkdownContent({ content, terminalColumns }: MarkdownProps) {
  const theme = useTheme();
  if (!content) return null;
  return (
    <box style={{ flexDirection: "column", width: terminalColumns ? terminalColumns - 2 : undefined }}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {React.createElement("markdown" as any, {
        content,
        style: {
          textColor: theme.userMessageText,
          codeBackgroundColor: theme.inputBg,
          codeTextColor: theme.code,
          headerColor: theme.brand,
          linkColor: theme.traceCommand,
        },
      })}
    </box>
  );
}

/**
 * Streaming variant. With OpenTUI's double-buffered renderer there's no
 * tearing penalty for re-parsing on every token — the renderer composes the
 * full frame natively before swapping. So we just delegate to the same
 * primitive and let it handle partial input.
 */
export function StreamingMarkdown({ content, terminalColumns }: MarkdownProps) {
  return <MarkdownContent content={content} terminalColumns={terminalColumns} />;
}
/**
 * Transcript row renderer (Phase 5): DisplayMessage[] -> styled terminal
 * rows. Pure — no pi-tui/Ink imports; the pi app feeds rows into Text
 * components and unit tests assert the strings directly.
 *
 * Visual parity targets from the legacy renderer (message-list.tsx):
 *   - user message: highlighted card, '›' marker, vertical padding
 *   - assistant: plain wrapped text, blank-line separated
 *   - reasoning: dim, collapsed to one line unless expanded
 *   - tool calls: single-line trace with status glyph, name, arg preview,
 *     error result preview
 *   - synthetic rows (interrupt, compaction, notices) rendered as notices
 */
import chalk from "chalk";
import { DisplayToolCall, DisplayMessage } from "../model/display-history.js";

function toolTraceLabel(tool: DisplayToolCall): string {
  return tool.name;
}

export interface TranscriptRenderOptions {
  columns: number;
  showReasoning?: boolean;
  verboseTrace?: boolean;
  theme?: TranscriptTheme;
}

export interface TranscriptTheme {
  userBg: (text: string) => string;
  userText: (text: string) => string;
  accent: (text: string) => string;
  dim: (text: string) => string;
  error: (text: string) => string;
  success: (text: string) => string;
}

export const defaultTranscriptTheme: TranscriptTheme = {
  userBg: (text) => chalk.bgHex("#22354A")(text),
  userText: (text) => chalk.hex("#E8EDF4")(text),
  accent: (text) => chalk.cyan(text),
  dim: (text) => chalk.dim(text),
  error: (text) => chalk.red(text),
  success: (text) => chalk.green(text),
};

/** Visible-width-preserving truncation (no ANSI awareness needed pre-style). */
function truncateVisible(text: string, maxColumns: number): string {
  if (text.length <= maxColumns) return text;
  if (maxColumns <= 1) return "…";
  return `${text.slice(0, Math.max(0, maxColumns - 1))}…`;
}

export function renderUserCard(content: string, options: TranscriptRenderOptions): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  const width = Math.max(20, options.columns - 2);
  const textWidth = width - 4; // " › " + trailing pad

  const lines = wrapPlain(content, textWidth);
  const rows: string[] = [];
  const pad = " ".repeat(width);
  rows.push(theme.userBg(pad));
  lines.forEach((line, index) => {
    const filled = (index === 0 ? theme.accent(" › ") : "   ") + theme.userText(line.padEnd(textWidth)) + " ";
    rows.push(theme.userBg(filled));
  });
  rows.push(theme.userBg(pad));
  rows.push("");
  return rows;
}

export function wrapPlain(text: string, columns: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      // Hard-break words longer than the column budget (URLs, long CJK runs,
      // base64...) so no physical row ever exceeds the width.
      const chunks: string[] = [];
      for (let i = 0; i < word.length; i += columns) {
        chunks.push(word.slice(i, i + columns));
      }
      for (const chunk of chunks) {
        const candidate = line ? `${line} ${chunk}` : chunk;
        if (candidate.length > columns && line) {
          out.push(line);
          line = chunk;
        } else {
          line = candidate;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function renderAssistant(content: string, options: TranscriptRenderOptions): string[] {
  const width = Math.max(20, options.columns - 2);
  return [...wrapPlain(content, width), ""];
}

export function renderReasoning(content: string, options: TranscriptRenderOptions): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  if (!options.showReasoning) {
    const firstLine = content.split("\n")[0] ?? "";
    const preview = truncateVisible(firstLine, Math.max(10, options.columns - 16));
    return [theme.dim(`└─ thinking: ${preview} (Ctrl+T to expand)`), ""];
  }
  const width = Math.max(20, options.columns - 4);
  return [
    theme.dim("└─ thinking"),
    ...wrapPlain(content, width).map((line) => theme.dim(`   ${line}`)),
    "",
  ];
}

function argPreview(tool: DisplayToolCall): string {
  const args = tool.args as Record<string, unknown>;
  const firstString = ["command", "path", "pattern", "file_path", "url", "query"].find((key) => typeof args?.[key] === "string");
  if (firstString) return String(args[firstString]);
  const raw = Object.keys(args ?? {})[0];
  return raw ? String(args[raw]).slice(0, 40) : "";
}

export function renderToolTrace(tool: DisplayToolCall, options: TranscriptRenderOptions): string {
  const theme = options.theme ?? defaultTranscriptTheme;
  const label = toolTraceLabel(tool) || tool.name;
  const preview = argPreview(tool);

  const glyph = tool.isError
    ? theme.error("✗")
    : tool.result !== undefined
      ? theme.success("✔")
      : theme.dim("…");

  const name = theme.accent(label);
  const parts = [` ${glyph} ${name}`];
  if (preview) parts.push(theme.dim(` ${truncateVisible(preview, Math.max(12, options.columns - label.length - 12))}`));

  if (tool.isError && tool.result !== undefined && options.verboseTrace) {
    const errPreview = truncateVisible(String(tool.result).split("\n")[0] ?? "", options.columns - 8);
    parts.push(`\n   ${theme.error(errPreview)}`);
  } else if (!tool.isError && options.verboseTrace && tool.result !== undefined) {
    const okPreview = truncateVisible(String(tool.result).split("\n")[0] ?? "", options.columns - 8);
    parts.push(`\n   ${theme.dim(okPreview)}`);
  }
  return parts.join("");
}

export function renderMessage(message: DisplayMessage, options: TranscriptRenderOptions): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  if (message.role === "user") {
    return renderUserCard(message.content, options);
  }
  if (message.role === "error") {
    return [theme.error(truncateVisible(message.content, options.columns)), ""];
  }
  // Assistant (and synthetic assistant rows).
  const rows: string[] = [];
  if (message.reasoning) {
    rows.push(...renderReasoning(message.reasoning, options));
  }
  if (message.toolCalls?.length) {
    for (const tool of message.toolCalls) {
      rows.push(renderToolTrace(tool, options));
    }
  }
  if (message.content?.trim()) {
    rows.push(...renderAssistant(message.content, options));
  } else if (rows.length === 0) {
    rows.push("");
  }
  return rows;
}

export function renderTranscript(messages: readonly DisplayMessage[], options: TranscriptRenderOptions): string[] {
  const rows: string[] = [];
  for (const message of messages) {
    rows.push(...renderMessage(message, options));
  }
  return rows;
}

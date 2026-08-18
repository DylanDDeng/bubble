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
import stringWidth from "string-width";
import { truncateVisual } from "../../text-display.js";
import { DisplayToolCall, DisplayMessage } from "../model/display-history.js";

function toolTraceLabel(tool: DisplayToolCall): string {
  return tool.name;
}

export interface TranscriptRenderOptions {
  columns: number;
  showReasoning?: boolean;
  verboseTrace?: boolean;
  theme?: TranscriptTheme;
  /** Optional markdown pipeline for assistant content (app injects pi-tui's
   *  Markdown component; the default is plain wrapped text). */
  markdownRenderer?: (text: string, width: number) => string[];
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

/** Visible-width-preserving truncation (input is unstyled at this point). */
function truncateVisible(text: string, maxColumns: number): string {
  return truncateVisual(text, maxColumns);
}

export function renderUserCard(content: string, options: TranscriptRenderOptions): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  // Leave two terminal cells unpainted. Painting the physical last column can
  // trigger an automatic wrap in several terminals and leaves a broken bg
  // patch at the right edge.
  const width = Math.max(20, options.columns - 2);
  const textWidth = width - 4; // " › " + trailing pad

  const lines = wrapPlain(content, textWidth);
  const rows: string[] = [];
  const pad = " ".repeat(width);
  rows.push(theme.userBg(pad));
  lines.forEach((line, index) => {
    // JS length/padEnd counts code units, not terminal cells: CJK characters
    // occupy two columns. Visual padding prevents the line from overflowing,
    // hard-wrapping, and resetting the painted background before the edge.
    const padded = `${line}${" ".repeat(Math.max(0, textWidth - stringWidth(line)))}`;
    const filled = (index === 0 ? theme.accent(" › ") : "   ") + theme.userText(padded) + " ";
    rows.push(theme.userBg(filled));
  });
  // No bottom painted spacer: it made every sent message look one row too
  // tall and was the large blue gap visible before Thinking/Working.
  return rows;
}

export function wrapPlain(text: string, columns: number): string[] {
  const out: string[] = [];
  const splitToken = (token: string): string[] => {
    const chunks: string[] = [];
    let chunk = "";
    let width = 0;
    for (const char of token) {
      const charWidth = stringWidth(char);
      if (chunk && width + charWidth > columns) {
        chunks.push(chunk);
        chunk = "";
        width = 0;
      }
      chunk += char;
      width += charWidth;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  };

  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      for (const chunk of splitToken(word)) {
        const candidate = line ? `${line} ${chunk}` : chunk;
        if (line && stringWidth(candidate) > columns) {
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
  if (options.markdownRenderer) {
    return [...options.markdownRenderer(content, width), ""];
  }
  return [...wrapPlain(content, width), ""];
}

export function renderReasoning(content: string, options: TranscriptRenderOptions): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  if (!options.showReasoning) {
    const firstLine = content.split("\n")[0] ?? "";
    const preview = truncateVisible(firstLine, Math.max(10, options.columns - 16));
    return [theme.dim(`└─ Thinking: ${preview} (Ctrl+T to expand)`), ""];
  }
  const width = Math.max(20, options.columns - 4);
  return [
    theme.dim("└─ Thinking"),
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

interface RequestTraceState {
  thinkingShown: boolean;
  workingShown: boolean;
}

/**
 * Render one assistant provider-turn as part of the surrounding user request.
 *
 * One agent run may contain many provider turns (`turn_end.willContinue`) —
 * normally one before every tool call. Rendering every turn independently
 * exposes the implementation boundary as `thinking → tool → thinking → tool`.
 * The user-facing trace is instead one request lifecycle:
 *
 *   Thinking (first collapsed reasoning only)
 *   Working
 *     tool
 *     tool
 *   final answer
 *
 * Expanded mode still retains every reasoning segment for diagnostics.
 */
function renderAssistantInRequest(
  message: DisplayMessage,
  options: TranscriptRenderOptions,
  trace: RequestTraceState,
): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  const rows: string[] = [];

  if (message.reasoning && (options.showReasoning || !trace.thinkingShown)) {
    rows.push(...renderReasoning(message.reasoning, options));
    trace.thinkingShown = true;
  }

  const appendTools = (tools: readonly DisplayToolCall[]) => {
    if (!trace.workingShown) {
      rows.push(theme.dim("└─ Working"));
      trace.workingShown = true;
    }
    for (const tool of tools) {
      rows.push(`  ${renderToolTrace(tool, options)}`);
    }
  };

  // Preserve the model's real commentary/tool timeline. `parts` is the
  // canonical ordered stream; the top-level fields are only the fallback for
  // restored/legacy messages. Rendering toolCalls first and content second
  // inverted commentary that was emitted before a tool call.
  if (message.parts?.length) {
    for (const part of message.parts) {
      if (part.type === "tools") {
        appendTools(part.toolCalls);
      } else if (part.content.trim()) {
        rows.push(...renderAssistant(part.content, options));
      }
    }
  } else {
    if (message.toolCalls?.length) appendTools(message.toolCalls);
    if (message.content?.trim()) rows.push(...renderAssistant(message.content, options));
  }
  return rows;
}

export function renderTranscript(messages: readonly DisplayMessage[], options: TranscriptRenderOptions): string[] {
  const rows: string[] = [];
  let trace: RequestTraceState = { thinkingShown: false, workingShown: false };

  for (const message of messages) {
    if (message.role === "user") {
      trace = { thinkingShown: false, workingShown: false };
      rows.push(...renderUserCard(message.content, options));
    } else if (message.role === "assistant" && !message.syntheticKind) {
      rows.push(...renderAssistantInRequest(message, options, trace));
    } else {
      rows.push(...renderMessage(message, options));
    }
  }
  return rows;
}

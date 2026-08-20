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
import { darkTheme } from "../model/theme.js";
import { buildTraceGroups, traceGroupLabel, type TraceGroup } from "../model/trace-groups.js";

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
  userBg: (text) => chalk.bgHex(darkTheme.userMessageBg)(text),
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
  const terminalWidth = Math.max(1, Math.floor(options.columns));
  // Leave two terminal cells unpainted. Painting the physical last column can
  // trigger an automatic wrap in several terminals and leaves a broken bg
  // patch at the right edge. At one or two columns there is no room to reserve
  // that margin, so use every available cell.
  const width = terminalWidth > 2 ? terminalWidth - 2 : terminalWidth;
  // The normal card gutter is four cells (marker + trailing pad). On an
  // extremely narrow terminal, degrade to a plain painted row; forcing the
  // historical 20-column minimum is what made settled rows overflow after a
  // 20x5 resize even though the live trace itself was width-safe.
  if (width < 5) {
    return wrapPlain(content, width).map((line) => theme.userBg(truncateVisible(line, width)));
  }
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
  // Keep the painted padding symmetric so the message body is vertically
  // centered. Separation from the following trace belongs outside the card;
  // removing only the bottom pad shifts every message down by half a row.
  rows.push(theme.userBg(pad));
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
  const terminalWidth = Math.max(1, Math.floor(options.columns));
  const width = Math.max(1, terminalWidth - 2);
  if (options.markdownRenderer) {
    return [
      ...options.markdownRenderer(content, width).map((row) => truncateVisible(row, terminalWidth)),
      "",
    ];
  }
  return [
    ...wrapPlain(content, width).map((row) => truncateVisible(row, terminalWidth)),
    "",
  ];
}

export function renderReasoning(content: string, options: TranscriptRenderOptions): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  const columns = Math.max(1, options.columns);
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const visible = options.showReasoning ? lines : lines.slice(0, 2);
  const rows = [theme.dim(truncateVisible("  ✻ Thinking", columns))];
  for (const line of visible) {
    for (const wrapped of wrapPlain(line, Math.max(1, columns - 2))) {
      rows.push(theme.dim(truncateVisible(`  ${wrapped}`, columns)));
    }
  }
  if (!options.showReasoning && lines.length > visible.length) {
    rows.push(theme.dim(truncateVisible("  … (Ctrl+T to expand)", columns)));
  }
  rows.push("");
  return rows;
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

export interface TraceGroupRenderOptions {
  /** Live Ink parity: identify the last group that is actually still active. */
  showActivity?: boolean;
}

/**
 * Render the same semantic trace groups used by the Ink TUI. This is shared
 * by the live row pool and settled transcript so tool_start/tool_update/
 * tool_end cannot change from a rich trace into an unrelated one-line row at
 * the commit boundary.
 */
export function renderToolTraceGroups(
  toolCalls: readonly DisplayToolCall[],
  options: TranscriptRenderOptions,
  renderOptions: TraceGroupRenderOptions = {},
): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  const columns = Math.max(1, options.columns);
  const groups = buildTraceGroups([...toolCalls]);
  const rows: string[] = [];
  const active = renderOptions.showActivity
    ? [...groups].reverse().find((group) => group.pending)
    : undefined;

  if (active) {
    rows.push(theme.dim(truncateVisible(`  ● Working on ${traceGroupLabel(active)}`, columns)));
  }

  for (const group of groups) {
    rows.push(...renderTraceGroup(group, options));
  }
  return rows;
}

function renderTraceGroup(group: TraceGroup, options: TranscriptRenderOptions): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  const columns = Math.max(1, options.columns);
  const status = group.pending
    ? " running"
    : group.hasError
      ? ` ${group.errorCount || 1} error${(group.errorCount || 1) === 1 ? "" : "s"}`
      : "";
  const detail = group.description
    ? ` ${group.description}`
    : group.command
      ? ` ${group.command.replace(/\s+/g, " ")}`
      : group.count !== undefined && group.noun
        ? ` ${group.count} ${group.noun}`
        : "";
  const header = `  ${group.title}${detail}${status}`;
  const allErrored = group.hasError && group.errorCount >= group.raw.length && !group.pending;
  const rows = [allErrored
    ? theme.error(truncateVisible(header, columns))
    : truncateVisible(header, columns)];

  // While Execute is running, retain the command's own lines just like Ink.
  // The header is only a summary and may be truncated on a narrow terminal.
  const commandLines = group.commandLines ?? [];
  const commandNeedsBlock = group.kind === "execute"
    && (group.pending || group.hasError)
    && (
      !!group.description
      || commandLines.length > 1
      || stringWidth(`  ${group.title} ${group.command ?? ""}`) > columns
    );
  if (commandNeedsBlock) {
    const wrappedCommand = commandLines.flatMap((line) => wrapPlain(line || " ", Math.max(1, columns - 4)));
    for (const line of wrappedCommand.slice(0, 4)) {
      rows.push(theme.dim(truncateVisible(`    ${line}`, columns)));
    }
    if (wrappedCommand.length > 4) {
      rows.push(theme.dim(truncateVisible(`    … ${wrappedCommand.length - 4} more lines`, columns)));
    }
  }

  const collapseSuccessfulExecute = group.kind === "execute"
    && !group.pending
    && !group.hasError
    && !options.verboseTrace;
  const details = group.previewLines.length > 0 ? group.previewLines : group.items;
  if (collapseSuccessfulExecute) {
    const outputLines = group.previewLines.length + group.omitted;
    rows.push(theme.dim(truncateVisible(
      `    ⎿  ${outputLines > 0
        ? `${outputLines} line${outputLines === 1 ? "" : "s"} output · Ctrl+O to view`
        : "no output"}`,
      columns,
    )));
  } else {
    for (let index = 0; index < details.length; index += 1) {
      const prefix = index === 0 ? "    ↳ " : "      ";
      const line = truncateVisible(`${prefix}${details[index] ?? ""}`, columns);
      rows.push(allErrored ? theme.error(line) : theme.dim(line));
    }
  }
  for (let index = 0; index < group.errorLines.length; index += 1) {
    const prefix = index === 0 ? "    ↳ " : "      ";
    rows.push(theme.error(truncateVisible(`${prefix}${group.errorLines[index] ?? ""}`, columns)));
  }
  if (group.omitted > 0) {
    rows.push(theme.dim(truncateVisible(`    … ${group.omitted} more`, columns)));
  }
  return rows;
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
    rows.push(...renderToolTraceGroups(message.toolCalls, options));
  }
  if (message.content?.trim()) {
    rows.push(...renderAssistant(message.content, options));
  } else if (rows.length === 0) {
    rows.push("");
  }
  return rows;
}

interface RequestTraceState {
  workingShown: boolean;
}

/**
 * Render one assistant provider-turn as part of the surrounding user request.
 *
 * One agent run may contain many provider turns (`turn_end.willContinue`) —
 * normally one before every tool call. Rendering every turn independently
 * exposes the implementation boundary as `thinking → tool → thinking → tool`.
 * The user-facing tool trace is grouped into one request lifecycle, while
 * every provider turn's reasoning remains visible. Live rendering exposes
 * each new reasoning segment, so suppressing later segments only after settle
 * would create another disappear-at-finalize jump.
 *
 *   Thinking
 *   Working (one request-level heading)
 *     tool
 *   Thinking (a later provider turn, if present)
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

  if (message.reasoning) {
    rows.push(...renderReasoning(message.reasoning, options));
  }

  const appendTools = (tools: readonly DisplayToolCall[]) => {
    if (!trace.workingShown) {
      rows.push(theme.dim(truncateVisible("  ● Working", Math.max(1, options.columns))));
      trace.workingShown = true;
    }
    rows.push(...renderToolTraceGroups(tools, options));
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
  let trace: RequestTraceState = { workingShown: false };

  for (const message of messages) {
    if (message.role === "user") {
      trace = { workingShown: false };
      rows.push(...renderUserCard(message.content, options));
    } else if (message.role === "assistant" && !message.syntheticKind) {
      rows.push(...renderAssistantInRequest(message, options, trace));
    } else {
      rows.push(...renderMessage(message, options));
    }
  }
  return rows;
}

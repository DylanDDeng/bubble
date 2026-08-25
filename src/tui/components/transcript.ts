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
import { buildTraceGroups, formatTracePath, type TraceGroup } from "../model/trace-groups.js";
import type { TraceInteractionState, TraceRowTarget } from "../model/trace-interaction.js";

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
  /** Shared UI-only selection/fold state for interactive tool groups. */
  traceInteraction?: TraceInteractionState;
  /** Keep a final transcript spacer; fullscreen disables it once no live tail follows. */
  trailingSpacer?: boolean;
  /** Preview a destructive rewrite by dimming this message and everything after it. */
  dimFromMessageIndex?: number;
}

export interface TranscriptProjection {
  rows: string[];
  /** Row-aligned pointer targets; undefined rows remain ordinary selectable text. */
  traceTargets: Array<TraceRowTarget | undefined>;
  /** Semantic padding survives hover painting, so joins never add/remove rows. */
  leadingSpacer?: boolean;
  trailingSpacer?: boolean;
}

function plainProjection(rows: readonly string[]): TranscriptProjection {
  return {
    rows: [...rows],
    traceTargets: rows.map(() => undefined),
    leadingSpacer: rows.length > 0 && stringWidth(rows[0] ?? "") === 0,
    trailingSpacer: rows.length > 0 && stringWidth(rows.at(-1) ?? "") === 0,
  };
}

export function joinTranscriptProjections(blocks: readonly TranscriptProjection[]): TranscriptProjection {
  const rows: string[] = [];
  const traceTargets: Array<TraceRowTarget | undefined> = [];
  let leadingSpacer = false;
  let trailingSpacer = false;
  for (const block of blocks) {
    let start = 0;
    let end = block.rows.length;
    while (start < end && block.rows[start] === "") start += 1;
    while (end > start && block.rows[end - 1] === "") end -= 1;
    if (start === end) continue;
    const blockHasLeadingSpacer = start === 0
      ? (block.leadingSpacer ?? stringWidth(block.rows[start] ?? "") === 0)
      : stringWidth(block.rows[start] ?? "") === 0;
    if (rows.length === 0) leadingSpacer = blockHasLeadingSpacer;
    const previousHasSpacer = rows.length > 0 && trailingSpacer;
    if (rows.length > 0 && !previousHasSpacer && !blockHasLeadingSpacer) {
      rows.push("");
      traceTargets.push(undefined);
    }
    rows.push(...block.rows.slice(start, end));
    traceTargets.push(...block.traceTargets.slice(start, end));
    trailingSpacer = end === block.rows.length
      ? (block.trailingSpacer ?? stringWidth(block.rows[end - 1] ?? "") === 0)
      : stringWidth(block.rows[end - 1] ?? "") === 0;
  }
  return { rows, traceTargets, leadingSpacer, trailingSpacer };
}

export interface TranscriptTheme {
  userBg: (text: string) => string;
  userText: (text: string) => string;
  accent: (text: string) => string;
  dim: (text: string) => string;
  error: (text: string) => string;
  success: (text: string) => string;
  /** Dim chrome used by Grok-style pointer hover around tool entries. */
  hoverBorder?: (text: string) => string;
  /** Brighter chrome used by Grok for the selected scrollback entry. */
  selectionBorder?: (text: string) => string;
  /** Full-width neutral surface painted inside a hovered tool entry. */
  hoverBackground?: (text: string) => string;
  /** Persistent surface painted while the tool entry is selected. */
  selectionBackground?: (text: string) => string;
}

export const defaultTranscriptTheme: TranscriptTheme = {
  userBg: (text) => chalk.bgHex(darkTheme.userMessageBg)(text),
  userText: (text) => chalk.hex("#E8EDF4")(text),
  accent: (text) => chalk.cyan(text),
  dim: (text) => chalk.dim(text),
  error: (text) => chalk.red(text),
  success: (text) => chalk.green(text),
  hoverBorder: (text) => chalk.gray.dim(text),
  selectionBorder: (text) => chalk.gray(text),
  hoverBackground: (text) => chalk.bgHex(darkTheme.traceHoverBg)(text),
  selectionBackground: (text) => chalk.bgHex(darkTheme.traceSelectedBg)(text),
};

const TRACE_BORDER_MIN_COLUMNS = 4;
const TRACE_CONTENT_LEFT_PAD = 2;
const TRACE_RESERVED_COLUMNS = 4; // left border + content pad + right border
// Keep a zero-width row in projection joins without painting a terminal cell.
// The row exists in layout at rest, so hover can add corners without reflow.
const TRACE_IDLE_VPAD = "\x1b[0m";

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

/**
 * Project assistant prose without transcript spacing. Live streaming and
 * settled history both call this function, so completing a turn cannot change
 * the answer gutter or wrapping width.
 */
export function projectAssistantRows(content: string, options: TranscriptRenderOptions): string[] {
  const terminalWidth = Math.max(1, Math.floor(options.columns));
  const width = Math.max(1, terminalWidth - 2);
  if (options.markdownRenderer) {
    return options.markdownRenderer(content, width)
      .map((row) => truncateVisible(row, terminalWidth));
  }
  return wrapPlain(content, width)
    .map((row) => truncateVisible(row, terminalWidth));
}

export function renderAssistant(content: string, options: TranscriptRenderOptions): string[] {
  return [...projectAssistantRows(content, options), ""];
}

/**
 * Join reasoning, tool, and prose surfaces with one semantic separator.
 * Individual projectors own only their visible rows; this composition layer
 * owns vertical rhythm, so live and settled timelines cannot drift apart.
 */
export function joinTranscriptBlocks(blocks: readonly (readonly string[])[]): string[] {
  const rows: string[] = [];
  for (const block of blocks) {
    let start = 0;
    let end = block.length;
    while (start < end && block[start] === "") start += 1;
    while (end > start && block[end - 1] === "") end -= 1;
    if (start === end) continue;
    if (rows.length > 0 && rows.at(-1) !== "") rows.push("");
    rows.push(...block.slice(start, end));
  }
  return rows;
}

export interface ReasoningProjectionOptions {
  /** In-flight reasoning uses the only stateful visual difference Grok keeps. */
  running?: boolean;
  /** Maximum number of physical reasoning body rows. */
  maxBodyRows?: number;
  /** Minimal reasoning keeps the newest rows in both live and settled states. */
  fromEnd?: boolean;
}

/** Grok minimal mode keeps the same rolling reasoning surface live/settled. */
export const MINIMAL_REASONING_BODY_ROWS = 5;

/**
 * Grok-style reasoning surface. Reasoning alone owns a one-cell rail; normal
 * assistant prose never inherits this gutter. The same projection is used by
 * the live row pool and committed transcript.
 */
export function projectReasoningRows(
  content: string,
  options: TranscriptRenderOptions,
  projection: ReasoningProjectionOptions = {},
): string[] {
  const theme = options.theme ?? defaultTranscriptTheme;
  const columns = Math.max(1, Math.floor(options.columns));
  const bodyWidth = Math.max(1, columns - 1);
  const body = content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => wrapPlain(line, bodyWidth));
  if (body.length === 0) return [];

  const limit = Math.max(0, projection.maxBodyRows ?? (
    options.showReasoning ? body.length : MINIMAL_REASONING_BODY_ROWS
  ));
  const fromEnd = projection.fromEnd ?? !options.showReasoning;
  const visible = limit === 0
    ? []
    : fromEnd
      ? body.slice(-limit)
      : body.slice(0, limit);
  const style = (text: string) => theme.dim(chalk.italic(text));
  const rows = [style(truncateVisible(`┃◆ Thinking${projection.running ? "…" : ""}`, columns))];
  for (const line of visible) {
    rows.push(style(truncateVisible(`┃${line}`, columns)));
  }
  if (body.length > visible.length) {
    const suffix = options.showReasoning ? "┃…" : "┃… (Ctrl+T to expand)";
    rows.push(style(truncateVisible(suffix, columns)));
  }
  return rows;
}

export function renderReasoning(content: string, options: TranscriptRenderOptions): string[] {
  const rows = projectReasoningRows(content, options);
  if (rows.length === 0) return [];
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

  const columns = Math.max(1, Math.floor(options.columns));
  const text = truncateVisible(`◆ ${label}${preview ? ` ${preview}` : ""}`, columns);
  const parts = [tool.isError ? theme.error(text) : `${theme.accent("◆")}${text.slice(1)}`];

  if (tool.isError && tool.result !== undefined && options.verboseTrace) {
    const errPreview = String(tool.result).split("\n")[0] ?? "";
    parts.push(`\n${theme.error(truncateVisible(`  ↳ ${errPreview}`, columns))}`);
  } else if (!tool.isError && options.verboseTrace && tool.result !== undefined) {
    const okPreview = String(tool.result).split("\n")[0] ?? "";
    parts.push(`\n${theme.dim(truncateVisible(`  ↳ ${okPreview}`, columns))}`);
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
  return projectToolTraceGroups(toolCalls, options, renderOptions).rows;
}

export function projectToolTraceGroups(
  toolCalls: readonly DisplayToolCall[],
  options: TranscriptRenderOptions,
  renderOptions: TraceGroupRenderOptions = {},
): TranscriptProjection {
  const groups = buildTraceGroups([...toolCalls]);
  const rows: string[] = [];
  const traceTargets: Array<TraceRowTarget | undefined> = [];
  // `showActivity` remains part of the call contract, but Grok expresses
  // activity by mutating the tool entry itself (`running`) instead of adding
  // a second Working heading with a different marker.
  void renderOptions.showActivity;

  for (const group of groups) {
    const projected = projectTraceGroup(group, options);
    rows.push(...projected.rows);
    traceTargets.push(...projected.traceTargets);
  }
  return {
    rows,
    traceTargets,
    leadingSpacer: groups.length > 0,
    trailingSpacer: groups.length > 0,
  };
}

function projectTraceGroup(group: TraceGroup, options: TranscriptRenderOptions): TranscriptProjection {
  const theme = options.theme ?? defaultTranscriptTheme;
  const columns = Math.max(1, options.columns);
  const frameColumns = columns > 2 ? columns - 2 : columns;
  const contentColumns = frameColumns >= TRACE_BORDER_MIN_COLUMNS
    ? Math.max(1, frameColumns - TRACE_RESERVED_COLUMNS)
    : frameColumns;
  const interaction = options.traceInteraction;
  const groupKey = interaction?.groupKey(group);
  const readInteraction = group.kind === "read" ? interaction : undefined;
  const singleRead = readInteraction && groupKey && group.raw.length === 1 ? group.raw[0] : undefined;
  const singleItemKey = singleRead && interaction ? interaction.itemKey(group, singleRead.id) : undefined;
  const interactive = interaction !== undefined && groupKey !== undefined;
  const groupFoldable = isTraceGroupFoldable(group);
  const singleItemFoldable = singleRead ? isTraceItemFoldable(singleRead) : false;
  const expanded = interactive
    ? singleItemKey
      ? interaction!.isItemExpanded(singleItemKey)
      : interaction!.isGroupExpanded(groupKey!)
    : false;
  const selected = interaction?.isSelected(singleItemKey ?? groupKey ?? "") ?? false;
  const marker = expanded ? "⌄" : selected ? "›" : "◆";
  const status = group.pending
    ? " running"
    : group.hasError
      ? ` ${group.errorCount || 1} error${(group.errorCount || 1) === 1 ? "" : "s"}`
      : group.statusLabel
        ? ` ${group.statusLabel}`
        : "";
  const detail = singleRead
    ? ` ${readTraceLabel(singleRead)}`
    : group.description
      ? ` ${group.description}`
      : group.command
        ? ` ${group.command.replace(/\s+/g, " ")}`
        : group.count !== undefined && group.noun
          ? ` ${group.count} ${group.noun}`
          : "";
  const header = `${marker} ${group.title}${detail}${status}`;
  const rows = [group.hasError
    ? theme.error(truncateVisible(header, contentColumns))
    : `${theme.accent(marker)}${truncateVisible(header.slice(marker.length), Math.max(0, contentColumns - stringWidth(marker)))}`];
  const subagentIds = group.kind === "subagent"
    ? (group.raw[0]?.metadata?.subagents as Array<{ subAgentId?: unknown }> | undefined)
      ?.map((member) => typeof member?.subAgentId === "string" ? member.subAgentId : "")
      .filter(Boolean) ?? []
    : [];
  const groupAction = subagentIds.length === 1
    ? { kind: "open-subagent" as const, subAgentId: subagentIds[0]! }
    : undefined;
  const groupTarget: TraceRowTarget | undefined = groupKey
    ? { kind: "group", key: groupKey, groupKey, foldable: groupFoldable, action: groupAction }
    : undefined;
  const singleTarget: TraceRowTarget | undefined = singleItemKey && groupKey && singleRead
    ? { kind: "item", key: singleItemKey, groupKey, toolId: singleRead.id, foldable: singleItemFoldable }
    : undefined;
  const traceTargets: Array<TraceRowTarget | undefined> = [singleTarget ?? groupTarget];
  const finish = (): TranscriptProjection => decorateTraceGroup(
    { rows, traceTargets },
    singleTarget ?? groupTarget,
    groupKey,
    frameColumns,
    theme,
    interaction,
  );

  // Interactive Read groups follow Grok's scrollback model: the summary row
  // is collapsed by default; double-click reveals member rows. Individual
  // members then own their file preview fold without changing the whole group.
  if (readInteraction && groupKey) {
    if (singleRead && singleTarget) {
      if (expanded) appendReadPreview(rows, traceTargets, singleRead, singleTarget, contentColumns, theme, "  ");
      return finish();
    }
    if (!expanded) return finish();
    for (const tool of group.raw) {
      const itemKey = readInteraction.itemKey(group, tool.id);
      const itemExpanded = readInteraction.isItemExpanded(itemKey);
      const itemSelected = readInteraction.isSelected(itemKey);
      const itemMarker = itemExpanded ? "⌄" : itemSelected ? "›" : "◆";
      const label = readTraceLabel(tool);
      const itemText = truncateVisible(`  ${itemMarker} ${label}`, contentColumns);
      rows.push(tool.isError ? theme.error(itemText) : theme.dim(itemText));
      const itemTarget: TraceRowTarget = {
        kind: "item",
        key: itemKey,
        groupKey,
        toolId: tool.id,
        foldable: isTraceItemFoldable(tool),
      };
      traceTargets.push(itemTarget);
      if (itemExpanded) {
        appendReadPreview(
          rows,
          traceTargets,
          tool,
          itemTarget,
          contentColumns,
          theme,
          "    ",
        );
      }
    }
    return finish();
  }

  // Grok tool blocks are collapsed by default. A single click selects the
  // entry; a double-click reveals the detail surface only when the block has
  // something meaningful to reveal. Failed List/Search blocks are deliberately
  // non-foldable and keep their error detail visible in-place.
  if (interactive && groupFoldable && !expanded) return finish();

  // While Execute is running, retain the command's own lines just like Ink.
  // The header is only a summary and may be truncated on a narrow terminal.
  const commandLines = group.commandLines ?? [];
  const commandNeedsBlock = group.kind === "execute"
    && (
      !!group.description
      || commandLines.length > 1
      || stringWidth(`◆ ${group.title} ${group.command ?? ""}`) > contentColumns
    );
  if (commandNeedsBlock) {
    const wrappedCommand = commandLines.flatMap((line) => wrapPlain(line || " ", Math.max(1, contentColumns - 2)));
    for (const line of wrappedCommand.slice(0, 4)) {
      rows.push(theme.dim(truncateVisible(`  ${line}`, contentColumns)));
      traceTargets.push(groupTarget);
    }
    if (wrappedCommand.length > 4) {
      rows.push(theme.dim(truncateVisible(`  … ${wrappedCommand.length - 4} more lines`, contentColumns)));
      traceTargets.push(groupTarget);
    }
  }

  const collapseSuccessfulExecute = !interactive
    && group.kind === "execute"
    && !group.pending
    && !group.hasError
    && !options.verboseTrace;
  const details = group.kind === "search"
    ? [...group.items, ...group.previewLines]
    : group.previewLines.length > 0
      ? group.previewLines
      : group.items;
  if (collapseSuccessfulExecute) {
    const outputLines = group.previewLines.length + group.omitted;
    rows.push(theme.dim(truncateVisible(
      `  ⎿  ${outputLines > 0
        ? `${outputLines} line${outputLines === 1 ? "" : "s"} output · Ctrl+O to view`
        : "no output"}`,
      contentColumns,
    )));
    traceTargets.push(groupTarget);
  } else {
    for (let index = 0; index < details.length; index += 1) {
      const prefix = index === 0 ? "  ↳ " : "    ";
      const line = truncateVisible(`${prefix}${details[index] ?? ""}`, contentColumns);
      rows.push(group.hasError ? theme.error(line) : theme.dim(line));
      traceTargets.push(groupTarget);
    }
  }
  for (let index = 0; index < group.errorLines.length; index += 1) {
    const prefix = index === 0 ? "  ↳ " : "    ";
    rows.push(theme.error(truncateVisible(`${prefix}${group.errorLines[index] ?? ""}`, contentColumns)));
    traceTargets.push(groupTarget);
  }
  if (group.omitted > 0) {
    rows.push(theme.dim(truncateVisible(`  … ${group.omitted} more`, contentColumns)));
    traceTargets.push(groupTarget);
  }
  return finish();
}

function decorateTraceGroup(
  projection: TranscriptProjection,
  target: TraceRowTarget | undefined,
  groupKey: string | undefined,
  columns: number,
  theme: TranscriptTheme,
  interaction: TraceInteractionState | undefined,
): TranscriptProjection {
  const selected = groupKey !== undefined && interaction?.isGroupSelected(groupKey) === true;
  const hovered = groupKey !== undefined
    && interaction?.isGroupHovered(groupKey) === true
    && !selected;
  const active = selected || hovered;
  const border = selected
    ? (theme.selectionBorder ?? theme.hoverBorder ?? theme.dim)
    : (theme.hoverBorder ?? theme.dim);
  const background = selected
    ? (theme.selectionBackground ?? theme.hoverBackground ?? ((text: string) => text))
    : (theme.hoverBackground ?? ((text: string) => text));

  if (columns < TRACE_BORDER_MIN_COLUMNS) {
    return {
      rows: [
        TRACE_IDLE_VPAD,
        ...projection.rows.map((row) => {
          if (!active) return row;
          const clipped = truncateVisible(row, columns);
          return background(`${clipped}${" ".repeat(Math.max(0, columns - stringWidth(clipped)))}`);
        }),
        TRACE_IDLE_VPAD,
      ],
      traceTargets: [target, ...projection.traceTargets, target],
      leadingSpacer: true,
      trailingSpacer: true,
    };
  }

  const top = active
    ? border(`┌${" ".repeat(columns - 2)}┐`)
    : TRACE_IDLE_VPAD;
  const bottom = active
    ? border(`└${" ".repeat(columns - 2)}┘`)
    : TRACE_IDLE_VPAD;
  const rows = projection.rows.map((row) => {
    if (!active) return `${" ".repeat(TRACE_CONTENT_LEFT_PAD + 1)}${row}`;
    const interior = `${" ".repeat(TRACE_CONTENT_LEFT_PAD)}${row}`;
    const padding = " ".repeat(Math.max(0, columns - 2 - stringWidth(interior)));
    return `${border("│")}${background(`${interior}${padding}`)}${border("│")}`;
  });
  return {
    rows: [top, ...rows, bottom],
    traceTargets: [target, ...projection.traceTargets, target],
    leadingSpacer: true,
    trailingSpacer: true,
  };
}

function isTraceItemFoldable(tool: DisplayToolCall): boolean {
  return typeof tool.result === "string" && tool.result.trim().length > 0;
}

function isTraceGroupFoldable(group: TraceGroup): boolean {
  switch (group.kind) {
    case "read":
      return group.raw.length > 1 || group.raw.some(isTraceItemFoldable);
    case "list":
      return !group.hasError && (group.items.length > 0 || group.omitted > 0);
    case "search":
      // Grok keeps successful Search entries foldable even for zero results so
      // the expanded view can still reveal the query metadata / no-result state.
      return !group.hasError;
    case "execute":
      return !!group.description
        || (group.commandLines?.length ?? 0) > 1
        || group.previewLines.length > 0
        || group.errorLines.length > 0
        || group.omitted > 0;
    default:
      return false;
  }
}

function readTraceLabel(tool: DisplayToolCall): string {
  const value = tool.args.path ?? tool.args.file ?? tool.metadata?.path ?? argPreview(tool);
  return formatTracePath(value || tool.name);
}

function appendReadPreview(
  rows: string[],
  traceTargets: Array<TraceRowTarget | undefined>,
  tool: DisplayToolCall,
  target: TraceRowTarget,
  columns: number,
  theme: TranscriptTheme,
  indent: string,
): void {
  if (tool.result === undefined) return;
  const normalized = tool.result.replace(/\r\n/g, "\n");
  const source = tool.name === "bash" && normalized.startsWith("stdout:\n")
    ? normalized.slice("stdout:\n".length)
    : normalized;
  const preview = source
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => wrapPlain(line, Math.max(1, columns - indent.length)));
  for (const line of preview.slice(0, 8)) {
    rows.push((tool.isError ? theme.error : theme.dim)(truncateVisible(`${indent}${line}`, columns)));
    traceTargets.push(target);
  }
  if (preview.length > 8) {
    rows.push(theme.dim(truncateVisible(`${indent}… ${preview.length - 8} more lines`, columns)));
    traceTargets.push(target);
  }
}

/**
 * Manual Compact keeps its terminal event deliberately terse, but the summary
 * that replaced the old context remains inspectable. Treat the event as the
 * same scrollback surface as a settled tool trace: hover/select paint the
 * complete row and double-click folds the real summary in place.
 */
function projectCompactionSummary(
  message: DisplayMessage,
  options: TranscriptRenderOptions,
): TranscriptProjection {
  const theme = options.theme ?? defaultTranscriptTheme;
  const columns = Math.max(1, options.columns);
  const frameColumns = columns > 2 ? columns - 2 : columns;
  const contentColumns = frameColumns >= TRACE_BORDER_MIN_COLUMNS
    ? Math.max(1, frameColumns - TRACE_RESERVED_COLUMNS)
    : frameColumns;
  const interaction = options.traceInteraction;
  const groupKey = `compact:${message.key ?? `${message.content}:${message.compactionSummary ?? ""}`}`;
  const target: TraceRowTarget = {
    kind: "group",
    key: groupKey,
    groupKey,
    foldable: true,
  };
  const expanded = interaction?.isGroupExpanded(groupKey) ?? false;
  const selected = interaction?.isSelected(groupKey) ?? false;
  const marker = expanded ? "⌄" : selected ? "›" : "◆";
  const label = message.content.trim() || "Compaction completed.";
  const header = `${marker} ${label}`;
  const rows = [
    `${theme.accent(marker)}${truncateVisible(
      header.slice(marker.length),
      Math.max(0, contentColumns - stringWidth(marker)),
    )}`,
  ];
  const traceTargets: Array<TraceRowTarget | undefined> = [target];

  if (expanded) {
    const summary = message.compactionSummary?.trim() ?? "";
    const bodyWidth = Math.max(1, contentColumns - 2);
    const bodyRows = options.markdownRenderer
      ? options.markdownRenderer(summary, bodyWidth)
      : wrapPlain(summary, bodyWidth);
    for (const row of bodyRows) {
      rows.push(theme.dim(truncateVisible(`  ${row}`, contentColumns)));
      traceTargets.push(target);
    }
  }

  return decorateTraceGroup(
    { rows, traceTargets },
    target,
    groupKey,
    frameColumns,
    theme,
    interaction,
  );
}

export function renderMessage(message: DisplayMessage, options: TranscriptRenderOptions): string[] {
  return projectMessage(message, options).rows;
}

export function projectMessage(message: DisplayMessage, options: TranscriptRenderOptions): TranscriptProjection {
  const theme = options.theme ?? defaultTranscriptTheme;
  if (message.role === "user") {
    return plainProjection(renderUserCard(message.content, options));
  }
  if (message.role === "error") {
    return plainProjection([...projectAssistantRows(message.content, options).map(theme.error), ""]);
  }
  if (message.syntheticKind === "ui_compact_summary" && message.compactionSummary?.trim()) {
    return projectCompactionSummary(message, options);
  }
  if (message.syntheticKind) {
    return plainProjection([
      ...projectAssistantRows(message.content, { ...options, markdownRenderer: undefined }).map(theme.dim),
      "",
    ]);
  }
  const blocks: TranscriptProjection[] = [];
  if (message.reasoning) blocks.push(plainProjection(projectReasoningRows(message.reasoning, options)));
  if (message.toolCalls?.length) blocks.push(projectToolTraceGroups(message.toolCalls, options));
  if (message.content?.trim()) blocks.push(plainProjection(projectAssistantRows(message.content, options)));
  const projection = joinTranscriptProjections(blocks);
  if (projection.rows.length === 0) return plainProjection([""]);
  projection.rows.push("");
  projection.traceTargets.push(undefined);
  projection.trailingSpacer = true;
  return projection;
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
 *   ◆ tool
 *   Thinking (a later provider turn, if present)
 *     tool
 *   final answer
 *
 * Expanded mode still retains every reasoning segment for diagnostics.
 */
function projectAssistantInRequest(
  message: DisplayMessage,
  options: TranscriptRenderOptions,
): TranscriptProjection {
  const blocks: TranscriptProjection[] = [];

  if (message.reasoning) {
    blocks.push(plainProjection(projectReasoningRows(message.reasoning, options)));
  }

  const appendTools = (tools: readonly DisplayToolCall[]) => {
    blocks.push(projectToolTraceGroups(tools, options));
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
        blocks.push(plainProjection(projectAssistantRows(part.content, options)));
      }
    }
  } else {
    if (message.toolCalls?.length) appendTools(message.toolCalls);
    if (message.content?.trim()) blocks.push(plainProjection(projectAssistantRows(message.content, options)));
  }
  return joinTranscriptProjections(blocks);
}

export function renderTranscript(messages: readonly DisplayMessage[], options: TranscriptRenderOptions): string[] {
  return projectTranscript(messages, options).rows;
}

export function projectTranscript(
  messages: readonly DisplayMessage[],
  options: TranscriptRenderOptions,
): TranscriptProjection {
  const messageBlocks: TranscriptProjection[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    let block: TranscriptProjection;
    if (message.role === "user") {
      block = plainProjection(renderUserCard(message.content, options));
    } else if (message.role === "assistant" && !message.syntheticKind) {
      block = projectAssistantInRequest(message, options);
    } else {
      block = projectMessage(message, options);
    }
    if (options.dimFromMessageIndex !== undefined && messageIndex >= options.dimFromMessageIndex) {
      block = {
        ...block,
        rows: block.rows.map((row) => row ? chalk.dim(row) : row),
      };
    }
    messageBlocks.push(block);
  }
  const projection = joinTranscriptProjections(messageBlocks);
  // The transcript owns the sole separator before a live assistant surface.
  // When that surface settles, the same row becomes the transcript's trailing
  // separator, so user -> Thinking geometry cannot change at commit time.
  if (projection.rows.length === 0) return projection;
  if (options.trailingSpacer !== false) {
    projection.rows.push("");
    projection.traceTargets.push(undefined);
    projection.trailingSpacer = true;
  }
  return projection;
}

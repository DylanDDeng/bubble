import React from "react";
import { Box, Static, Text } from "ink";
import { theme } from "./theme.js";
import { highlightCode, inferLang } from "./code-highlight.js";
import { MarkdownContent } from "./markdown.js";
import type { DisplayMessage, DisplayToolCall } from "./display-history.js";

/**
 * Hint surfaced when the user can interrupt the currently-running pending tool
 * via the approval dialog. The match is loose (by request type → tool name),
 * since ApprovalRequest does not carry a toolCallId today.
 */
export interface PendingApprovalHint {
  toolName: "edit" | "write" | "bash";
  path?: string;
  command?: string;
}

interface MessageListProps {
  messages: DisplayMessage[];
  streamingContent: string;
  streamingReasoning: string;
  streamingTools: DisplayToolCall[];
  terminalColumns: number;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  /** Animation tick used to refresh in-progress elapsed counters. */
  nowTick?: number;
}

export function MessageList({
  messages,
  streamingContent,
  streamingReasoning,
  streamingTools,
  terminalColumns,
  verboseTrace,
  pendingApproval,
  nowTick,
}: MessageListProps) {
  const hasStreaming = !!(streamingContent || streamingReasoning || streamingTools.length > 0);
  // Split the message history so the trailing message — which can still be
  // mutated by a subsequent turn_end merging more content — stays in a normal
  // <Box>, while everything before it is committed to ink's <Static> region.
  // Static items render once into the terminal scrollback, so streaming
  // updates don't trigger a re-paint of older messages and the user's native
  // terminal scrollback works as expected.
  const lastIndex = messages.length - 1;
  const frozen = lastIndex >= 0 ? messages.slice(0, lastIndex) : [];
  const live = lastIndex >= 0 ? messages[lastIndex] : undefined;

  return (
    <Box flexDirection="column">
      <Static items={frozen}>
        {(msg, i) => (
          <MessageItem
            key={msg.key ?? `frozen-${i}`}
            message={msg}
            terminalColumns={terminalColumns}
            verboseTrace={verboseTrace}
            // Older messages don't anchor the expand hint — only the tail does.
            showExpandHint={false}
            nowTick={undefined}
          />
        )}
      </Static>
      {live && (
        <MessageItem
          key={live.key ?? "live"}
          message={live}
          terminalColumns={terminalColumns}
          verboseTrace={verboseTrace}
          showExpandHint={!hasStreaming}
          nowTick={nowTick}
        />
      )}
      {hasStreaming && (
        <StreamingMessage
          content={streamingContent}
          reasoning={streamingReasoning}
          tools={streamingTools}
          terminalColumns={terminalColumns}
          verboseTrace={verboseTrace}
          pendingApproval={pendingApproval}
          nowTick={nowTick}
        />
      )}
    </Box>
  );
}

function MessageItem({
  message,
  terminalColumns,
  verboseTrace,
  showExpandHint,
  nowTick,
}: {
  message: DisplayMessage;
  terminalColumns: number;
  verboseTrace: boolean;
  showExpandHint: boolean;
  nowTick?: number;
}) {
  if (message.role === "user") {
    return <UserMessageBlock content={message.content} terminalColumns={terminalColumns} />;
  }

  if (message.role === "error") {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text color={theme.error}>Error: {message.content}</Text>
      </Box>
    );
  }

  const lastToolIndex = (message.toolCalls?.length ?? 0) - 1;
  const hasVisibleAssistantContent =
    !!message.content ||
    (message.toolCalls?.length ?? 0) > 0 ||
    (!!message.reasoning && verboseTrace);
  if (!hasVisibleAssistantContent) return null;

  return (
    <Box marginBottom={1} flexDirection="column">
      {message.reasoning && verboseTrace && <ReasoningTraceBlock reasoning={message.reasoning} />}
      {message.toolCalls?.map((tc, idx) => (
        <ToolCallDisplay
          key={tc.id}
          toolCall={tc}
          verbose={verboseTrace}
          terminalColumns={terminalColumns}
          // Only attach the keyboard-shortcut hint to the last collapsed tool
          // of the most recent message — repeating it on every old tool was
          // visual noise.
          showExpandHint={showExpandHint && idx === lastToolIndex}
          compactTop={idx === 0}
          nowTick={nowTick}
        />
      ))}
      {message.content && <MarkdownContent content={message.content} />}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <TurnDigest toolCalls={message.toolCalls} />
      )}
    </Box>
  );
}

function StreamingMessage({
  content,
  reasoning,
  tools,
  terminalColumns,
  verboseTrace,
  pendingApproval,
  nowTick,
}: {
  content: string;
  reasoning: string;
  tools: DisplayToolCall[];
  terminalColumns: number;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  nowTick?: number;
}) {
  const deferredContent = React.useDeferredValue(content);
  const deferredReasoning = React.useDeferredValue(reasoning);

  const lastIdx = tools.length - 1;
  return (
    <Box marginBottom={1} flexDirection="column">
      {deferredReasoning && verboseTrace && <ReasoningTraceBlock reasoning={deferredReasoning} />}
      {tools.map((tc, idx) => {
        const isWaitingApproval =
          !tc.result && !!pendingApproval && approvalMatchesTool(pendingApproval, tc);
        return (
          <ToolCallDisplay
            key={tc.id}
            toolCall={tc}
            isStreaming={!tc.result}
            verbose={verboseTrace}
            terminalColumns={terminalColumns}
            showExpandHint={idx === lastIdx}
            waitingApproval={isWaitingApproval}
            compactTop={idx === 0}
            nowTick={nowTick}
          />
        );
      })}
      {deferredContent && <MarkdownContent content={deferredContent} />}
    </Box>
  );
}

function approvalMatchesTool(hint: PendingApprovalHint, tc: DisplayToolCall): boolean {
  if (hint.toolName !== tc.name) return false;
  if (hint.toolName === "bash") {
    return !hint.command || hint.command === tc.args.command;
  }
  return !hint.path || hint.path === tc.args.path;
}

function ReasoningTraceBlock({ reasoning }: { reasoning: string }) {
  const lines = React.useMemo(
    () => reasoning.split("\n").filter((l) => l.trim() !== ""),
    [reasoning],
  );
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color={theme.thinkingDim} dimColor>
        ✻ Reasoning trace{lines.length > 0 ? ` · ${lines.length} line${lines.length === 1 ? "" : "s"}` : ""}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} color={theme.thinkingDim} dimColor italic>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function UserMessageBlock({ content, terminalColumns }: { content: string; terminalColumns: number }) {
  const horizontalRoom = Math.max(20, terminalColumns - 4);
  const contentWidth = Math.max(1, horizontalRoom - 2);
  const wrappedLines = content
    .split("\n")
    .flatMap((line) => wrapByVisualWidth(line, contentWidth));

  return (
    <Box flexDirection="column">
      {wrappedLines.map((line, index) => (
        <Box key={index}>
          <Text color={theme.userRail}>▌ </Text>
          <Text color={theme.userMessageText}>{line || " "}</Text>
        </Box>
      ))}
    </Box>
  );
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};

const TOOL_GLYPHS: Record<string, string> = {
  read: "⏺",
  write: "✎",
  edit: "✎",
  bash: "▶",
  grep: "⌕",
  glob: "⌕",
  web_fetch: "⇲",
  web_search: "⌕",
  task: "↳",
  todo: "✓",
  skill: "★",
};

function displayToolName(name: string): string {
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function toolGlyph(name: string): string {
  return TOOL_GLYPHS[name] ?? "●";
}

function extractDiffBody(result: string): string | null {
  const idx = result.indexOf("\nDiff:\n");
  if (idx === -1) return null;
  return result.slice(idx + "\nDiff:\n".length);
}

function parseDiffStats(result: string): { added: number; removed: number } | null {
  const body = extractDiffBody(result);
  if (!body) return null;
  let added = 0;
  let removed = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function getToolHeader(toolCall: DisplayToolCall): string | undefined {
  const args = toolCall.args || {};
  const trunc = (s: string, n = 50) => (s.length > n ? s.slice(0, n) + "..." : s);
  switch (toolCall.name) {
    case "read":
    case "write":
    case "edit":
      return args.path ? trunc(String(args.path), 60) : undefined;
    case "bash":
      return args.command ? trunc(String(args.command).replace(/\n/g, " "), 60) : undefined;
    case "grep":
      return args.pattern ? trunc(String(args.pattern), 60) : undefined;
    case "glob":
      return args.pattern ? trunc(String(args.pattern), 60) : undefined;
    case "web_fetch":
      return args.url ? trunc(String(args.url), 60) : undefined;
    case "web_search":
      return args.query ? trunc(String(args.query), 60) : undefined;
    default:
      return undefined;
  }
}

function summarizeToolResult(tc: DisplayToolCall): string {
  if (!tc.result) return "pending";
  const raw = tc.result.replace(/\r\n/g, "\n");
  if (tc.isError) {
    const firstLine = raw.split("\n").find((l) => l.trim() !== "") || "Error";
    return firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine;
  }
  const nonEmpty = raw.split("\n").filter((l) => l.trim() !== "");
  const lineCount = nonEmpty.length;
  const p = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;
  switch (tc.name) {
    case "read":
      return p(lineCount, "line", "lines");
    case "write": {
      const firstLine = raw.split("\n")[0] || "";
      if (firstLine.startsWith("Wrote ") || firstLine.startsWith("Updated ")) {
        return firstLine;
      }
      return "Wrote file";
    }
    case "edit": {
      const stats = parseDiffStats(raw);
      if (stats) return `+${stats.added} -${stats.removed} lines`;
      return "Patched file";
    }
    case "bash":
      return lineCount > 0 ? `${p(lineCount, "line", "lines")} output` : "Done";
    case "grep":
      return `Found ${p(lineCount, "match", "matches")}`;
    case "glob":
      return `Found ${p(lineCount, "file", "files")}`;
    case "web_search":
      return `${p(lineCount, "result", "results")}`;
    case "web_fetch":
      return p(lineCount, "line", "lines");
    default:
      return lineCount > 0 ? p(lineCount, "line", "lines") : "Done";
  }
}

const COLLAPSED_PREVIEW_LINES = 10;
const EXPANDED_PREVIEW_LINES = 50;

function ToolCallDisplay({
  toolCall,
  isStreaming,
  verbose,
  terminalColumns,
  showExpandHint = false,
  waitingApproval = false,
  compactTop = false,
  nowTick,
}: {
  toolCall: DisplayToolCall;
  isStreaming?: boolean;
  verbose: boolean;
  terminalColumns: number;
  showExpandHint?: boolean;
  waitingApproval?: boolean;
  compactTop?: boolean;
  nowTick?: number;
}) {
  // Show raw output immediately, then upgrade to highlighted ANSI when shiki
  // resolves. Avoids a noticeable "flash" where the line jumps from empty/raw
  // to colorized after a tick.
  const initialPreview = React.useMemo(() => {
    if (!toolCall.result || toolCall.isError) return null;
    return toolCall.result.replace(/\r\n/g, "\n");
  }, [toolCall.result, toolCall.isError]);
  const [highlighted, setHighlighted] = React.useState<string | null>(initialPreview);
  const header = getToolHeader(toolCall);
  const maxLines = verbose ? EXPANDED_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES;

  React.useEffect(() => {
    let cancelled = false;
    if (!toolCall.result || toolCall.isError) {
      setHighlighted(null);
      return;
    }
    const raw = toolCall.result.replace(/\r\n/g, "\n");
    let lang = "text";
    if (toolCall.name === "read") lang = inferLang(toolCall.args.path);
    else if (toolCall.name === "bash") lang = "shell";
    // Always seed with raw so the user sees content immediately.
    setHighlighted(raw);
    if (lang === "text") {
      return;
    }
    highlightCode(raw, lang)
      .then((out) => {
        if (!cancelled) setHighlighted(out);
      })
      .catch(() => {
        if (!cancelled) setHighlighted(raw);
      });
    return () => {
      cancelled = true;
    };
  }, [toolCall.result, toolCall.name, toolCall.args.path, toolCall.isError]);

  const glyph = toolGlyph(toolCall.name);
  const bulletColor = toolCall.isError
    ? theme.error
    : waitingApproval
      ? theme.warning
      : isStreaming
        ? theme.toolPending
        : theme.user;
  const name = displayToolName(toolCall.name);
  // Compose summary: pending tools get an elapsed counter; waiting-for-approval
  // gets an explicit badge so the trail survives the dialog closing.
  let summary: string;
  let summaryColor: string = theme.muted;
  if (waitingApproval) {
    summary = "⏸ waiting for approval";
    summaryColor = theme.warning;
  } else if (!toolCall.result && toolCall.startedAt) {
    const elapsedSec = Math.max(0, Math.floor(((nowTick ?? Date.now()) - toolCall.startedAt) / 1000));
    summary = elapsedSec > 0 ? `running · ${elapsedSec}s` : "running";
    summaryColor = theme.toolPending;
  } else {
    summary = summarizeToolResult(toolCall);
    if (toolCall.isError) summaryColor = theme.error;
  }

  const isEditDiff = toolCall.name === "edit" && !toolCall.isError && toolCall.result;
  // Only show the file preview once the tool actually executed. During the
  // streaming-args phase, args.content is incomplete and re-rendering the
  // entire body per delta both looks chaotic and breaks on partial escapes.
  const isWritePreview = toolCall.name === "write" && !toolCall.isError && !!toolCall.result;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Box>
        <Text color={bulletColor}>{glyph} </Text>
        <Text bold color={theme.toolName}>{name}</Text>
        {header && <Text color={theme.muted}>({header})</Text>}
      </Box>
      <Box marginLeft={2}>
        <Text color={summaryColor}>⎿  {summary}</Text>
      </Box>
      {toolCall.isError && toolCall.result && (
        <Box marginLeft={4} flexDirection="column">
          {toolCall.result.replace(/\r\n/g, "\n").split("\n").slice(0, 6).map((line, i) => (
            <Text key={i} color={theme.error}>{line}</Text>
          ))}
        </Box>
      )}
      {isEditDiff && (
        <DiffBlock
          result={toolCall.result!}
          terminalColumns={terminalColumns}
          maxLines={maxLines}
          verbose={verbose}
          showExpandHint={showExpandHint}
        />
      )}
      {isWritePreview && (
        <WritePreview
          content={String(toolCall.args.content || "")}
          maxLines={maxLines}
          verbose={verbose}
          showExpandHint={showExpandHint}
        />
      )}
      {!toolCall.isError && !isEditDiff && !isWritePreview && highlighted && (
        <OutputPreview
          text={highlighted}
          maxLines={maxLines}
          verbose={verbose}
          showExpandHint={showExpandHint}
        />
      )}
    </Box>
  );
}

function renderTruncationHint(remaining: number, verbose: boolean, showExpandHint: boolean): React.ReactNode {
  if (remaining <= 0) return null;
  const noun = `line${remaining === 1 ? "" : "s"}`;
  if (verbose) {
    return (
      <Text color={theme.muted}>
        ... ({remaining} more {noun})
      </Text>
    );
  }
  return (
    <Text color={theme.muted}>
      … +{remaining} {noun}
      {showExpandHint ? " (ctrl+o to expand)" : ""}
    </Text>
  );
}

function OutputPreview({
  text,
  maxLines,
  verbose,
  showExpandHint,
}: {
  text: string;
  maxLines: number;
  verbose: boolean;
  showExpandHint: boolean;
}) {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines);
  const remaining = Math.max(0, lines.length - maxLines);
  if (shown.length === 0 || (shown.length === 1 && shown[0] === "")) return null;
  return (
    <Box flexDirection="column" marginLeft={4}>
      {shown.map((line, i) => (
        <Box key={i}>
          <Text color={theme.muted}>│ </Text>
          <Text>{line}</Text>
        </Box>
      ))}
      {renderTruncationHint(remaining, verbose, showExpandHint)}
    </Box>
  );
}

function WritePreview({
  content,
  maxLines,
  verbose,
  showExpandHint,
}: {
  content: string;
  maxLines: number;
  verbose: boolean;
  showExpandHint: boolean;
}) {
  const lines = content.split("\n");
  const shown = lines.slice(0, maxLines);
  const remaining = Math.max(0, lines.length - maxLines);
  const numWidth = Math.max(2, String(lines.length).length);
  return (
    <Box flexDirection="column" marginLeft={4}>
      {shown.map((line, i) => (
        <Box key={i}>
          <Text color={theme.muted}>{String(i + 1).padStart(numWidth, " ")}  </Text>
          <Text>{line}</Text>
        </Box>
      ))}
      {renderTruncationHint(remaining, verbose, showExpandHint)}
    </Box>
  );
}

interface DiffLine {
  type: "context" | "add" | "remove";
  num: number;
  content: string;
}

function parseDiffLines(body: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;
  for (const raw of body.split("\n")) {
    if (
      raw.startsWith("+++") ||
      raw.startsWith("---") ||
      raw.startsWith("Index:") ||
      raw.startsWith("===")
    )
      continue;
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNum = parseInt(m[1]!, 10);
        newNum = parseInt(m[2]!, 10);
      }
      continue;
    }
    if (raw.startsWith("+")) {
      result.push({ type: "add", num: newNum, content: raw.slice(1) });
      newNum++;
    } else if (raw.startsWith("-")) {
      result.push({ type: "remove", num: oldNum, content: raw.slice(1) });
      oldNum++;
    } else {
      const content = raw.startsWith(" ") ? raw.slice(1) : raw;
      result.push({ type: "context", num: newNum, content });
      oldNum++;
      newNum++;
    }
  }
  return result;
}

function DiffBlock({
  result,
  terminalColumns,
  maxLines,
  verbose,
  showExpandHint,
}: {
  result: string;
  terminalColumns: number;
  maxLines: number;
  verbose: boolean;
  showExpandHint: boolean;
}) {
  const body = extractDiffBody(result);
  if (!body) return null;
  const lines = parseDiffLines(body);
  const shown = lines.slice(0, maxLines);
  const remaining = Math.max(0, lines.length - maxLines);

  const maxNum = lines.reduce((acc, l) => Math.max(acc, l.num), 0);
  const numWidth = Math.max(2, String(maxNum).length);
  const leftMargin = 2;
  const prefixWidth = numWidth + 4; // " NUM ± "
  // Reserve the full left-margin chain from terminal edge to diff content:
  // app padding (1) + ToolCallDisplay marginLeft (2) + DiffBlock marginLeft (2)
  // + right padding (1) + 1-col safety = 7. Without this, each row overflows
  // by 1 column, the terminal auto-wraps, and every line renders with a blank
  // row beneath it.
  const bandWidth = Math.max(10, terminalColumns - 7);
  const contentWidth = Math.max(1, bandWidth - prefixWidth);

  return (
    <Box flexDirection="column" marginLeft={leftMargin}>
      {shown.map((line, i) => {
        const bg =
          line.type === "add"
            ? theme.diffAdd
            : line.type === "remove"
              ? theme.diffRemove
              : undefined;
        const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        const numStr = String(line.num).padStart(numWidth, " ");
        const truncated = truncateVisual(line.content, contentWidth);
        const padded = padVisual(truncated, contentWidth);
        const lineText = ` ${numStr} ${sign} ${padded}`;
        return (
          <Text key={i} backgroundColor={bg} color={theme.userMessageText}>
            {lineText}
          </Text>
        );
      })}
      {renderTruncationHint(remaining, verbose, showExpandHint)}
    </Box>
  );
}

/**
 * "Edited 3 files (+42 -8) — a.ts, b.ts" digest below the assistant turn.
 * Surfaces only when there is at least one file-mutating tool call.
 */
function TurnDigest({ toolCalls }: { toolCalls: DisplayToolCall[] }) {
  const digest = React.useMemo(() => buildDigest(toolCalls), [toolCalls]);
  if (!digest) return null;
  return (
    <Box marginLeft={2} marginTop={1}>
      <Text color={theme.muted} dimColor>
        {digest}
      </Text>
    </Box>
  );
}

function buildDigest(toolCalls: DisplayToolCall[]): string | null {
  const paths = new Set<string>();
  let added = 0;
  let removed = 0;
  let writes = 0;
  let edits = 0;
  for (const tc of toolCalls) {
    if (tc.isError || !tc.result) continue;
    if (tc.name === "edit") {
      const stats = parseDiffStats(tc.result);
      if (stats) {
        added += stats.added;
        removed += stats.removed;
      }
      if (tc.args.path) paths.add(String(tc.args.path));
      edits += 1;
    } else if (tc.name === "write") {
      if (tc.args.path) paths.add(String(tc.args.path));
      writes += 1;
      const content = String(tc.args.content ?? "");
      if (content) added += content.split("\n").length;
    }
  }
  const total = edits + writes;
  if (total === 0 || paths.size === 0) return null;
  const verb = edits > 0 && writes === 0 ? "Edited" : writes > 0 && edits === 0 ? "Wrote" : "Touched";
  const pathList = Array.from(paths);
  const shownPaths = pathList.slice(0, 4).map((p) => p.split("/").pop() || p);
  const extra = pathList.length - shownPaths.length;
  const pathDisplay = shownPaths.join(", ") + (extra > 0 ? `, +${extra} more` : "");
  const stats =
    added || removed
      ? ` (${added ? `+${added}` : ""}${added && removed ? " " : ""}${removed ? `-${removed}` : ""})`
      : "";
  return `↳ ${verb} ${paths.size} file${paths.size === 1 ? "" : "s"}${stats} — ${pathDisplay}`;
}

function truncateVisual(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let out = "";
  let width = 0;
  for (const char of str) {
    const w = charVisualWidth(char);
    if (width + w > maxWidth) break;
    out += char;
    width += w;
  }
  return out;
}

function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padVisual(str: string, width: number): string {
  const currentWidth = visualWidth(str);
  return str + " ".repeat(Math.max(0, width - currentWidth));
}

function charVisualWidth(char: string): number {
  const code = char.codePointAt(0) || 0;
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff)
  ) {
    return 2;
  }
  return 1;
}

function wrapByVisualWidth(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [line];
  if (line === "") return [""];
  const result: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const char of line) {
    const w = charVisualWidth(char);
    if (currentWidth + w > maxWidth) {
      result.push(current);
      current = char;
      currentWidth = w;
    } else {
      current += char;
      currentWidth += w;
    }
  }
  if (current !== "" || result.length === 0) result.push(current);
  return result;
}

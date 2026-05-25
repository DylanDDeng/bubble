import React from "react";
import { Box, Static, Text } from "ink";
import { useTheme, type Theme } from "./theme.js";
import { highlightCode, inferLang } from "./code-highlight.js";
import { MarkdownContent, StreamingMarkdown } from "./markdown.js";
import type { DisplayMessage, DisplayMessagePart, DisplayToolCall } from "./display-history.js";
import { buildTraceGroups, formatTracePath, traceGroupLabel, type TraceGroup } from "./trace-groups.js";
import { EDIT_COLLAPSED_DIFF_LINES, formatEditSuccessSummary, getEditDiffDetails } from "./edit-diff.js";
import { formatSubagentRoute, type SubagentRouteLike } from "../agent/subagent-route-format.js";

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
  streamingParts: DisplayMessagePart[];
  terminalColumns: number;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  /** Animation tick used to refresh in-progress elapsed counters. */
  nowTick?: number;
  /** Optional banner rendered as the first item in the app-controlled transcript. */
  welcomeBanner?: React.ReactNode;
}

type MessageListItem =
  | { kind: "welcome"; key: string }
  | { kind: "message"; key: string; message: DisplayMessage; showExpandHint: boolean };

export function MessageList({
  messages,
  streamingContent,
  streamingReasoning,
  streamingTools,
  streamingParts,
  terminalColumns,
  verboseTrace,
  pendingApproval,
  nowTick,
  welcomeBanner,
}: MessageListProps) {
  const hasStreaming = !!(
    streamingContent ||
    streamingReasoning ||
    streamingTools.length > 0 ||
    streamingParts.length > 0
  );
  const staticItems: MessageListItem[] = [];
  if (welcomeBanner) {
    staticItems.push({ kind: "welcome", key: "welcome" });
  }
  const lastMessageIndex = messages.length - 1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    staticItems.push({
      kind: "message",
      key: msg.key ?? `message-${i}`,
      message: msg,
      showExpandHint: !hasStreaming && i === lastMessageIndex,
    });
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Static items={staticItems}>
        {(item) => {
          if (item.kind === "welcome") {
            return <React.Fragment key={item.key}>{welcomeBanner}</React.Fragment>;
          }
          return (
            <MessageItem
              key={item.key}
              message={item.message}
              terminalColumns={terminalColumns}
              verboseTrace={verboseTrace}
              showExpandHint={item.showExpandHint}
              nowTick={item.showExpandHint ? nowTick : undefined}
            />
          );
        }}
      </Static>
      {hasStreaming && (
        <StreamingMessage
          content={streamingContent}
          reasoning={streamingReasoning}
          tools={streamingTools}
          parts={streamingParts}
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
  const theme = useTheme();
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

  if (message.syntheticKind === "ui_compact_summary") {
    return <CompactionSummaryBlock message={message} />;
  }

  const hasVisibleAssistantContent =
    !!message.content ||
    (message.toolCalls?.length ?? 0) > 0 ||
    (message.parts?.length ?? 0) > 0 ||
    (!!message.reasoning && verboseTrace);
  if (!hasVisibleAssistantContent) return null;

  return (
    <Box marginTop={1} marginBottom={1} flexDirection="column">
      {message.reasoning && verboseTrace && <ReasoningTraceBlock reasoning={message.reasoning} />}
      {message.parts && message.parts.length > 0 ? (
        <MessageParts
          parts={message.parts}
          terminalColumns={terminalColumns}
          verboseTrace={verboseTrace}
          pendingApproval={undefined}
          showExpandHint={showExpandHint}
          nowTick={nowTick}
        />
      ) : (
        <>
          {message.toolCalls && (
            <ToolsPart
              toolCalls={message.toolCalls}
              terminalColumns={terminalColumns}
              verboseTrace={verboseTrace}
              pendingApproval={undefined}
              showExpandHint={showExpandHint}
              nowTick={nowTick}
            />
          )}
          {message.content && <MarkdownContent content={message.content} />}
        </>
      )}
      {verboseTrace && message.toolCalls && message.toolCalls.length > 0 && (
        <TurnDigest toolCalls={message.toolCalls} />
      )}
      {message.taskElapsedMs !== undefined && (
        <TaskDurationLine elapsedMs={message.taskElapsedMs} />
      )}
    </Box>
  );
}

function StreamingMessage({
  content,
  reasoning,
  tools,
  parts,
  terminalColumns,
  verboseTrace,
  pendingApproval,
  nowTick,
}: {
  content: string;
  reasoning: string;
  tools: DisplayToolCall[];
  parts: DisplayMessagePart[];
  terminalColumns: number;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  nowTick?: number;
}) {
  const deferredContent = React.useDeferredValue(content);
  const deferredReasoning = React.useDeferredValue(reasoning);
  const deferredParts = React.useDeferredValue(parts);
  const visibleParts = deferredParts.length > 0
    ? deferredParts
    : fallbackStreamingParts(deferredContent, tools);

  return (
    <Box flexDirection="column">
      {deferredReasoning && verboseTrace && (
        <Box marginTop={1} flexDirection="column">
          <ReasoningTraceBlock reasoning={deferredReasoning} />
        </Box>
      )}
      {visibleParts.length > 0 && (
        // marginTop intentionally 0: this Box only mounts on the first non-empty
        // streaming frame, so a marginTop=1 here would visibly insert a blank
        // line under the user message right at that moment (the "spinner sits
        // close, then content appears with a sudden gap, then spinner slides
        // down" effect users perceive as flicker on the DOM xterm renderer).
        // marginBottom=1 stays so streamed text doesn't collide with the
        // WaitingIndicator rendered below.
        <Box marginTop={0} marginBottom={1} flexDirection="column">
          <MessageParts
            parts={visibleParts}
            terminalColumns={terminalColumns}
            verboseTrace={verboseTrace}
            pendingApproval={pendingApproval}
            showExpandHint
            nowTick={nowTick}
            showActivity
            streaming
          />
        </Box>
      )}
    </Box>
  );
}

function MessageParts({
  parts,
  terminalColumns,
  verboseTrace,
  pendingApproval,
  showExpandHint,
  nowTick,
  showActivity = false,
  streaming = false,
}: {
  parts: DisplayMessagePart[];
  terminalColumns: number;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  showExpandHint: boolean;
  nowTick?: number;
  showActivity?: boolean;
  streaming?: boolean;
}) {
  const lastToolsPartIndex = findLastToolsPartIndex(parts);
  const lastTextPartIndex = findLastTextPartIndex(parts);
  return (
    <Box flexDirection="column">
      {parts.map((part, idx) => {
        if (part.type === "text") {
          return (
            <TimelineText
              key={`text-${idx}`}
              content={part.content}
              compactTop={idx === 0}
              terminalColumns={terminalColumns}
              streaming={streaming && idx === lastTextPartIndex}
            />
          );
        }
        return (
          <ToolsPart
            key={`tools-${idx}`}
            toolCalls={part.toolCalls}
            terminalColumns={terminalColumns}
            verboseTrace={verboseTrace}
            pendingApproval={pendingApproval}
            showExpandHint={showExpandHint && idx === lastToolsPartIndex}
            compactTop={idx === 0}
            nowTick={nowTick}
            showActivity={showActivity && idx === lastToolsPartIndex}
          />
        );
      })}
    </Box>
  );
}

function findLastTextPartIndex(parts: DisplayMessagePart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === "text") return i;
  }
  return -1;
}

function TimelineText({
  content,
  compactTop,
  terminalColumns,
  streaming = false,
}: {
  content: string;
  compactTop: boolean;
  terminalColumns?: number;
  /**
   * When true, this text is the in-flight tail of an active stream — render it
   * via `StreamingMarkdown` so already-closed blocks (tables, code fences,
   * etc.) commit to a memoized prefix and stop re-parsing on every token.
   */
  streaming?: boolean;
}) {
  const theme = useTheme();
  if (!content.trim()) return null;
  // marginLeft (2) + "⛬  " glyph (3 visual cells) = 5 cells consumed by the
  // timeline gutter; pass the remaining width so wide blocks like tables size
  // themselves against the actual content area instead of the raw terminal.
  const available = terminalColumns ? Math.max(20, terminalColumns - 5) : undefined;
  const trimmed = content.trim();
  return (
    <Box marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Text color={theme.agent}>⛬  </Text>
      <Box flexDirection="column" flexGrow={1}>
        {streaming ? (
          <StreamingMarkdown content={trimmed} maxWidth={available} />
        ) : (
          <MarkdownContent content={trimmed} maxWidth={available} />
        )}
      </Box>
    </Box>
  );
}

function ToolsPart({
  toolCalls,
  terminalColumns,
  verboseTrace,
  pendingApproval,
  showExpandHint,
  compactTop = false,
  nowTick,
  showActivity = false,
}: {
  toolCalls: DisplayToolCall[];
  terminalColumns: number;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  showExpandHint: boolean;
  compactTop?: boolean;
  nowTick?: number;
  showActivity?: boolean;
}) {
  if (toolCalls.length === 0) return null;
  if (!verboseTrace) {
    return (
      <TraceGroupList
        toolCalls={toolCalls}
        terminalColumns={terminalColumns}
        pendingApproval={pendingApproval}
        nowTick={nowTick}
        compactTop={compactTop}
        showActivity={showActivity}
      />
    );
  }

  const lastIdx = toolCalls.length - 1;
  return (
    <Box flexDirection="column">
      {toolCalls.map((tc, idx) => {
        const isWaitingApproval =
          tc.result === undefined && !!pendingApproval && approvalMatchesTool(pendingApproval, tc);
        return (
          <ToolCallDisplay
            key={tc.id}
            toolCall={tc}
            isStreaming={tc.result === undefined}
            verbose={verboseTrace}
            terminalColumns={terminalColumns}
            showExpandHint={showExpandHint && idx === lastIdx}
            waitingApproval={isWaitingApproval}
            compactTop={idx === 0 && compactTop}
            nowTick={nowTick}
          />
        );
      })}
    </Box>
  );
}

function fallbackStreamingParts(content: string, tools: DisplayToolCall[]): DisplayMessagePart[] {
  const parts: DisplayMessagePart[] = [];
  if (tools.length > 0) parts.push({ type: "tools", toolCalls: tools });
  if (content) parts.push({ type: "text", content });
  return parts;
}

function findLastToolsPartIndex(parts: DisplayMessagePart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === "tools") return i;
  }
  return -1;
}

function TraceGroupList({
  toolCalls,
  terminalColumns,
  pendingApproval,
  nowTick,
  compactTop = false,
  showActivity = false,
}: {
  toolCalls: DisplayToolCall[];
  terminalColumns: number;
  pendingApproval?: PendingApprovalHint | null;
  nowTick?: number;
  compactTop?: boolean;
  showActivity?: boolean;
}) {
  const groups = React.useMemo(() => buildTraceGroups(toolCalls), [toolCalls]);
  const activeGroup = showActivity ? findActiveTraceGroup(groups, pendingApproval) : undefined;

  if (groups.length === 0) return null;

  return (
    <Box flexDirection="column">
      {activeGroup && (
        <TraceActivityLine
          group={activeGroup}
          pendingApproval={pendingApproval}
          nowTick={nowTick}
          terminalColumns={terminalColumns}
        />
      )}
      {groups.map((group, idx) => (
        <TraceGroupBlock
          key={group.raw.map((tool) => tool.id).join(":")}
          group={group}
          terminalColumns={terminalColumns}
          pendingApproval={pendingApproval}
          compactTop={idx === 0 && compactTop}
          nowTick={nowTick}
        />
      ))}
    </Box>
  );
}

function TraceActivityLine({
  group,
  pendingApproval,
  nowTick,
  terminalColumns,
}: {
  group: TraceGroup;
  pendingApproval?: PendingApprovalHint | null;
  nowTick?: number;
  terminalColumns: number;
}) {
  const theme = useTheme();
  const waiting = isTraceGroupWaitingForApproval(group, pendingApproval);
  void nowTick;
  const labelWidth = Math.max(20, terminalColumns - 26);
  const label = truncateVisual(traceGroupLabel(group), labelWidth);
  return (
    <Box marginLeft={2}>
      <Text color={waiting ? theme.warning : theme.tracePending}>● </Text>
      <Text color={theme.traceDetail}>{waiting ? "Waiting for approval" : "Working on"} </Text>
      <Text color={theme.traceAction}>{label}</Text>
    </Box>
  );
}

function TraceGroupBlock({
  group,
  terminalColumns,
  pendingApproval,
  compactTop,
  nowTick,
}: {
  group: TraceGroup;
  terminalColumns: number;
  pendingApproval?: PendingApprovalHint | null;
  compactTop: boolean;
  nowTick?: number;
}) {
  const theme = useTheme();
  const waiting = isTraceGroupWaitingForApproval(group, pendingApproval);
  const status = traceGroupStatus(group, waiting, theme, nowTick);
  const editTool = group.kind === "edit" && group.raw.length === 1 ? group.raw[0] : undefined;
  const editDetails = editTool && !group.pending && !group.hasError ? getEditDiffDetails(editTool) : null;
  if (editTool && editDetails) {
    return (
      <EditTraceBlock
        tool={editTool}
        details={editDetails}
        terminalColumns={terminalColumns}
        compactTop={compactTop}
        status={status}
      />
    );
  }

  const allErrored = group.hasError && group.errorCount >= group.raw.length && !group.pending;
  const titleColor = allErrored ? theme.error : theme.traceAction;
  const detailColor = allErrored ? theme.error : theme.traceDetail;
  const commandWidth = Math.max(14, terminalColumns - group.title.length - 20);
  const detailWidth = Math.max(20, terminalColumns - 8);
  const detailLines = group.previewLines.length > 0 ? group.previewLines : group.items;
  // When a bash command is too long to fit on the title line, drop it onto its
  // own indented rows so narrow splits keep the full command visible instead of
  // silently truncating mid-flag.
  const commandFitsInline = !group.command || visualWidth(group.command) <= commandWidth;
  const wrappedCommandLines = group.command && !commandFitsInline
    ? wrapByVisualWidth(group.command, Math.max(10, detailWidth - 2))
    : null;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Text>
        <Text bold color={titleColor}>{group.title}</Text>
        {group.command && commandFitsInline ? (
          <Text color={theme.traceCommand}> {group.command}</Text>
        ) : !group.command && group.count !== undefined && group.noun ? (
          <Text color={theme.traceCount}> {group.count} {group.noun}</Text>
        ) : null}
        {status && <Text color={status.color}> {status.text}</Text>}
      </Text>
      {wrappedCommandLines && (
        <Box flexDirection="column" marginLeft={2}>
          {wrappedCommandLines.map((seg, idx) => (
            <Text key={`cmd-${idx}`} color={theme.traceCommand}>{seg}</Text>
          ))}
        </Box>
      )}
      {detailLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {detailLines.map((line, index) => (
            <Box key={index} marginLeft={index === 0 ? 0 : 2}>
              {index === 0 && <Text color={theme.traceDetail}>↳ </Text>}
              <Text color={detailColor}>{truncateVisual(line, detailWidth - (index === 0 ? 2 : 0))}</Text>
            </Box>
          ))}
        </Box>
      )}
      {group.errorLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {group.errorLines.map((line, index) => (
            <Box key={`error-${index}`} marginLeft={index === 0 ? 0 : 2}>
              {index === 0 && <Text color={theme.traceDetail}>↳ </Text>}
              <Text color={theme.error}>{truncateVisual(line, detailWidth - (index === 0 ? 2 : 0))}</Text>
            </Box>
          ))}
        </Box>
      )}
      {group.omitted > 0 && (
        <Box marginLeft={2}>
          <Text color={theme.traceDetail}>
            ... {group.omitted} more, Ctrl+O to view
          </Text>
        </Box>
      )}
    </Box>
  );
}

function EditTraceBlock({
  tool,
  details,
  terminalColumns,
  compactTop,
  status,
}: {
  tool: DisplayToolCall;
  details: NonNullable<ReturnType<typeof getEditDiffDetails>>;
  terminalColumns: number;
  compactTop: boolean;
  status: { text: string; color: string } | null;
}) {
  const theme = useTheme();
  const path = formatTracePath(details.path ?? tool.args.path ?? "");
  const pathWidth = Math.max(14, terminalColumns - 12);
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Text>
        <Text bold color={theme.traceAction}>Edit</Text>
        {path && <Text color={theme.traceCommand}> {truncateVisual(path, pathWidth)}</Text>}
        {status && <Text color={status.color}> {status.text}</Text>}
      </Text>
      <Box marginLeft={2}>
        <Text color={theme.traceDetail}>⎿  </Text>
        <Text color={theme.success}>{formatEditSuccessSummary(details)}</Text>
      </Box>
      <DiffBlock
        diff={details.diff}
        terminalColumns={terminalColumns}
        maxLines={EDIT_COLLAPSED_DIFF_LINES}
        verbose={false}
        showExpandHint={true}
      />
    </Box>
  );
}

function traceGroupStatus(
  group: TraceGroup,
  waitingApproval: boolean,
  theme: Theme,
  nowTick?: number,
): { text: string; color: string } | null {
  if (waitingApproval) return { text: "waiting for approval", color: theme.warning };
  if (group.pending) {
    void nowTick;
    return { text: "running", color: theme.tracePending };
  }
  if (group.hasError) {
    const count = group.errorCount || 1;
    return { text: count === 1 ? "1 error" : `${count} errors`, color: theme.error };
  }
  return null;
}

function findActiveTraceGroup(
  groups: TraceGroup[],
  pendingApproval?: PendingApprovalHint | null,
): TraceGroup | undefined {
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    if (isTraceGroupWaitingForApproval(group, pendingApproval) || group.pending) {
      return group;
    }
  }
  return undefined;
}

function isTraceGroupWaitingForApproval(
  group: TraceGroup,
  pendingApproval?: PendingApprovalHint | null,
): boolean {
  return !!pendingApproval && group.raw.some(
    (tool) => tool.result === undefined && approvalMatchesTool(pendingApproval, tool),
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
  const theme = useTheme();
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

function CompactionSummaryBlock({ message }: { message: DisplayMessage }) {
  const theme = useTheme();
  const rawStatus = message.content.replace(/^✓\s*/, "").trim();
  const status = rawStatus.replace(/^Compaction complete\s*(?:·\s*)?/i, "").trim() || "Session compacted";
  const summary = message.compactionSummary?.trim();
  return (
    <Box
      marginTop={1}
      marginBottom={1}
      paddingX={1}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Box flexDirection="row">
        <Text color={theme.success} bold>✓ </Text>
        <Text color={theme.accent} bold>Compaction checkpoint</Text>
        <Text color={theme.muted}> · {status}</Text>
      </Box>
      {summary && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.muted} dimColor>Preserved context summary</Text>
          <Box paddingLeft={2} flexDirection="column">
            <MarkdownContent content={summary} />
          </Box>
        </Box>
      )}
    </Box>
  );
}

function UserMessageBlock({ content, terminalColumns }: { content: string; terminalColumns: number }) {
  const theme = useTheme();
  // Rail and its right gutter must share the bubble background; otherwise the
  // terminal background shows up as a dark seam between rail and message.
  const railWidth = 2;
  const horizontalRoom = Math.max(20, terminalColumns - 2);
  const bubbleTextWidth = Math.max(1, horizontalRoom - railWidth - 2);
  const wrappedLines = content
    .split("\n")
    .flatMap((line) => wrapByVisualWidth(line, bubbleTextWidth));

  return (
    <Box flexDirection="column">
      {wrappedLines.map((line, index) => (
        <Box key={index}>
          <Text backgroundColor={theme.userMessageBg} color={theme.userRail}>
            {index === 0 ? "▌ " : "  "}
          </Text>
          <Text backgroundColor={theme.userMessageBg} color={theme.userMessageText}>
            {` ${padVisual(line || " ", bubbleTextWidth)} `}
          </Text>
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

interface SubagentDisplay {
  subAgentId?: string;
  agentName?: string;
  nickname?: string;
  status?: string;
  category?: string;
  route?: SubagentRouteLike;
  profileSource?: string;
  task?: string;
  summary?: string;
  toolNotes?: string[];
  error?: string;
}

function displayToolName(name: string): string {
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function toolGlyph(name: string): string {
  return TOOL_GLYPHS[name] ?? "●";
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
  if (tc.result === undefined) return "pending";
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
      return formatEditSuccessSummary(getEditDiffDetails(tc));
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

function subagentsFrom(toolCall: DisplayToolCall): SubagentDisplay[] {
  const raw = toolCall.metadata?.subagents;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is SubagentDisplay => typeof item === "object" && item !== null);
}

function latestSubagentNote(subagent: SubagentDisplay): string {
  const note = subagent.error
    || subagent.toolNotes?.filter(Boolean).at(-1)
    || subagent.summary
    || subagent.task
    || "";
  return note.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function subagentLabel(subagent: SubagentDisplay): string {
  return subagent.nickname ?? subagent.agentName ?? "subagent";
}

function subagentRole(subagent: SubagentDisplay): string {
  return [subagent.agentName, subagent.category ? `/${subagent.category}` : ""].join("") || "default";
}

function subagentDescriptor(subagent: SubagentDisplay, includeThinking = false): string {
  const route = formatSubagentRoute(subagent.route, { includeThinking });
  const role = subagentRole(subagent);
  return route ? `${role} @ ${route}` : role;
}

function subagentStatusColor(status: string | undefined, theme: Theme): string {
  if (status === "completed") return theme.success;
  if (status === "failed" || status === "blocked" || status === "cancelled") return theme.error;
  if (status === "queued") return theme.muted;
  return theme.toolPending;
}

function subagentSummary(subagents: SubagentDisplay[]): string {
  if (subagents.length === 0) return "no subagents";
  const counts = new Map<string, number>();
  for (const subagent of subagents) {
    const status = subagent.status ?? "running";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order = ["running", "queued", "completed", "blocked", "failed", "cancelled"];
  return order
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status}`)
    .join("  ");
}

function sortSubagents(subagents: SubagentDisplay[]): SubagentDisplay[] {
  const rank: Record<string, number> = {
    running: 0,
    blocked: 1,
    failed: 2,
    queued: 3,
    cancelled: 4,
    completed: 5,
  };
  return [...subagents].sort((a, b) => (rank[a.status ?? "running"] ?? 9) - (rank[b.status ?? "running"] ?? 9));
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
  const theme = useTheme();
  if (toolCall.metadata?.kind === "subagent") {
    return (
      <SubagentToolDisplay
        toolCall={toolCall}
        verbose={verbose}
        terminalColumns={terminalColumns}
        compactTop={compactTop}
      />
    );
  }

  // Show raw output immediately, then upgrade to highlighted ANSI when shiki
  // resolves. Avoids a noticeable "flash" where the line jumps from empty/raw
  // to colorized after a tick.
  const initialPreview = React.useMemo(() => {
    if (toolCall.result === undefined || toolCall.isError) return null;
    return toolCall.result.replace(/\r\n/g, "\n");
  }, [toolCall.result, toolCall.isError]);
  const [highlighted, setHighlighted] = React.useState<string | null>(initialPreview);
  const header = getToolHeader(toolCall);
  const maxLines = verbose ? EXPANDED_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES;

  React.useEffect(() => {
    let cancelled = false;
    if (toolCall.result === undefined || toolCall.isError) {
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
  // Compose summary: pending tools stay compact; waiting-for-approval gets an
  // explicit badge so the trail survives the dialog closing.
  let summary: string;
  let summaryColor: string = theme.muted;
  if (waitingApproval) {
    summary = "⏸ waiting for approval";
    summaryColor = theme.warning;
  } else if (toolCall.result === undefined && toolCall.startedAt) {
    void nowTick;
    summary = "running";
    summaryColor = theme.toolPending;
  } else {
    summary = summarizeToolResult(toolCall);
    if (toolCall.isError) summaryColor = theme.error;
    else if (toolCall.name === "edit" && toolCall.result !== undefined) summaryColor = theme.success;
  }

  const editDetails = getEditDiffDetails(toolCall);
  const isEditDiff = editDetails !== null && toolCall.result !== undefined;
  // Only show the file preview once the tool actually executed. During the
  // streaming-args phase, args.content is incomplete and re-rendering the
  // entire body per delta both looks chaotic and breaks on partial escapes.
  const isWritePreview = toolCall.name === "write" && !toolCall.isError && toolCall.result !== undefined;

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
          diff={editDetails!.diff}
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

function SubagentToolDisplay({
  toolCall,
  verbose,
  terminalColumns,
  compactTop,
}: {
  toolCall: DisplayToolCall;
  verbose: boolean;
  terminalColumns: number;
  compactTop: boolean;
}) {
  const theme = useTheme();
  const subagents = subagentsFrom(toolCall);
  const hasError = toolCall.isError || subagents.some((subagent) => (
    subagent.status === "failed" || subagent.status === "blocked" || subagent.status === "cancelled"
  ));
  const bulletColor = hasError ? theme.error : toolCall.result === undefined ? theme.toolPending : theme.user;
  const detailWidth = Math.max(24, terminalColumns - 10);
  const rows = verbose ? sortSubagents(subagents) : sortSubagents(subagents).slice(0, 4);
  const omitted = Math.max(0, subagents.length - rows.length);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Box>
        <Text color={bulletColor}>↳ </Text>
        <Text bold color={theme.toolName}>Subagents</Text>
        {subagents.length > 0 && <Text color={theme.muted}> {subagentSummary(subagents)}</Text>}
      </Box>
      {rows.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {rows.map((subagent, index) => {
            const status = subagent.status ?? "running";
            const label = padVisual(truncateVisual(subagentLabel(subagent), 10), 10);
            const descriptorWidth = verbose ? 42 : 32;
            const descriptor = padVisual(
              truncateVisual(subagentDescriptor(subagent), descriptorWidth),
              descriptorWidth,
            );
            const note = truncateVisual(
              latestSubagentNote(subagent),
              Math.max(12, detailWidth - 16 - descriptorWidth - 10),
            );
            return (
              <Box key={subagent.subAgentId ?? `${subagentLabel(subagent)}-${index}`}>
                <Text color={subagentStatusColor(status, theme)}>{label}</Text>
                <Text color={theme.traceAction}> {descriptor}</Text>
                <Text color={subagentStatusColor(status, theme)}> {padVisual(status, 9)}</Text>
                {note && <Text color={subagent.error ? theme.error : theme.traceDetail}> {note}</Text>}
              </Box>
            );
          })}
          {omitted > 0 && (
            <Text color={theme.muted}>... {omitted} more, Ctrl+O to view</Text>
          )}
        </Box>
      )}
      {subagents.length === 0 && toolCall.result && (
        <Box marginLeft={2}>
          <Text color={hasError ? theme.error : theme.muted}>{summarizeToolResult(toolCall)}</Text>
        </Box>
      )}
    </Box>
  );
}

function TruncationHint({
  remaining,
  verbose,
  showExpandHint,
}: {
  remaining: number;
  verbose: boolean;
  showExpandHint: boolean;
}): React.ReactNode {
  const theme = useTheme();
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
  const theme = useTheme();
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
      <TruncationHint remaining={remaining} verbose={verbose} showExpandHint={showExpandHint} />
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
  const theme = useTheme();
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
      <TruncationHint remaining={remaining} verbose={verbose} showExpandHint={showExpandHint} />
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
  const rawLines = body.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  for (const raw of rawLines) {
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
  diff,
  terminalColumns,
  maxLines,
  verbose,
  showExpandHint,
}: {
  diff: string;
  terminalColumns: number;
  maxLines: number;
  verbose: boolean;
  showExpandHint: boolean;
}) {
  const theme = useTheme();
  const lines = parseDiffLines(diff);
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

  const blankPrefix = " ".repeat(prefixWidth);

  return (
    <Box flexDirection="column" marginLeft={leftMargin}>
      {shown.flatMap((line, i) => {
        const bg =
          line.type === "add"
            ? theme.diffAdd
            : line.type === "remove"
              ? theme.diffRemove
              : undefined;
        const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        const numStr = String(line.num).padStart(numWidth, " ");
        // Soft-wrap long lines at the terminal-derived content width so narrow
        // splits still show the full content. Continuation rows reuse the same
        // background but blank out the gutter (no line number, no +/-) so a
        // reader can tell at a glance which rows belong to the same logical
        // diff line.
        const segments = wrapByVisualWidth(line.content, contentWidth);
        return segments.map((segment, segIdx) => {
          const padded = padVisual(segment, contentWidth);
          const prefix = segIdx === 0 ? ` ${numStr} ${sign} ` : blankPrefix;
          return (
            <Text key={`${i}-${segIdx}`} backgroundColor={bg} color={theme.userMessageText}>
              {`${prefix}${padded}`}
            </Text>
          );
        });
      })}
      <TruncationHint remaining={remaining} verbose={verbose} showExpandHint={showExpandHint} />
    </Box>
  );
}

/**
 * "Edited 3 files (+42 -8) — a.ts, b.ts" digest below the assistant turn.
 * Surfaces only when there is at least one file-mutating tool call.
 */
function TurnDigest({ toolCalls }: { toolCalls: DisplayToolCall[] }) {
  const theme = useTheme();
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

function TaskDurationLine({ elapsedMs }: { elapsedMs: number }) {
  const theme = useTheme();
  return (
    <Box marginLeft={2} marginTop={1}>
      <Text color={theme.muted} dimColor>
        Task duration: {formatDuration(elapsedMs)}
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
      const details = getEditDiffDetails(tc);
      if (details) {
        added += details.added;
        removed += details.removed;
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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  let minutes = Math.floor(seconds / 60);
  let remSec = Math.round(seconds - minutes * 60);
  if (remSec >= 60) {
    minutes += Math.floor(remSec / 60);
    remSec %= 60;
  }
  return remSec === 0 ? `${minutes}m` : `${minutes}m ${remSec}s`;
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

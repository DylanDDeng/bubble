import React from "react";
import { Box, Static, Text, measureElement, type DOMElement } from "ink";
import { useTheme, type Theme } from "./theme.js";
import { highlightCode, inferLang } from "./code-highlight.js";
import { MarkdownContent, StreamingMarkdown } from "./markdown.js";
import {
  userInputStatusBadgeLabel,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
  type UserInputStatus,
} from "./display-history.js";
import {
  buildTraceGroups,
  executeCommandBlock,
  formatTracePath,
  shouldInlineExecuteCommand,
  traceGroupLabel,
  type TraceGroup,
} from "./trace-groups.js";
import { EDIT_COLLAPSED_DIFF_LINES, formatEditSuccessSummary, getEditDiffDetails } from "./edit-diff.js";
import { formatSubagentRoute, type SubagentRouteLike } from "../agent/subagent-route-format.js";
import { sanitizeInternalReminderBlocks } from "../agent/internal-reminder-sanitizer.js";
import { splitImageDisplayContent } from "../tui/image-display.js";

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
  showThinking?: boolean;
  expandedToolOutput?: boolean;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  /** Animation tick used to refresh in-progress elapsed counters. */
  nowTick?: number;
  /** Optional banner rendered as the first item in the app-controlled transcript. */
  welcomeBanner?: React.ReactNode;
  /**
   * Bumped whenever the settled transcript is rebuilt non-monotonically
   * (/clear, /compact, /rewind, session switch). Used as the <Static> key so
   * Ink discards its already-printed rows and re-prints the rebuilt list onto
   * a freshly-cleared screen instead of appending duplicates.
   */
  staticGeneration?: number;
  /** Horizontal padding applied inside each committed/streaming row. */
  paddingX?: number;
  /**
   * Maximum height (rows) for the live/dynamic region. The in-progress turn is
   * clipped to this and pinned to the bottom (tail view) so the live frame
   * never exceeds the viewport — a taller-than-pane frame breaks Ink's redraw
   * under tmux. The full turn still lands in <Static> scrollback on commit.
   */
  maxStreamRows?: number;
}

const EXECUTE_COMMAND_BLOCK_MAX_LINES = 4;

type MessageListItem =
  | { kind: "welcome"; key: string }
  | {
      kind: "message";
      key: string;
      message: DisplayMessage;
      showExpandHint: boolean;
      separateFromPrevious: boolean;
    };

export function MessageList({
  messages,
  streamingContent,
  streamingReasoning,
  streamingTools,
  streamingParts,
  terminalColumns,
  showThinking = false,
  expandedToolOutput = false,
  verboseTrace,
  pendingApproval,
  nowTick,
  welcomeBanner,
  staticGeneration = 0,
  paddingX = 1,
  maxStreamRows,
}: MessageListProps) {
  const theme = useTheme();
  const hasStreaming = !!(
    streamingContent ||
    streamingReasoning ||
    streamingTools.length > 0 ||
    streamingParts.length > 0
  );
  const regularMessages = messages.filter((message) => !message.inputStatus);
  const pendingSteerMessages = messages.filter((message) => message.inputStatus === "pending_steer");
  const queuedInputMessages = messages.filter((message) => message.inputStatus === "queued");
  const staticItems: MessageListItem[] = [];
  if (welcomeBanner) {
    staticItems.push({ kind: "welcome", key: "welcome" });
  }
  const lastMessageIndex = regularMessages.length - 1;
  for (let i = 0; i < regularMessages.length; i++) {
    const msg = regularMessages[i]!;
    staticItems.push({
      kind: "message",
      key: msg.key ?? `message-${i}`,
      message: msg,
      showExpandHint: !hasStreaming && i === lastMessageIndex,
      separateFromPrevious: msg.role === "user" && regularMessages[i - 1]?.role === "user",
    });
  }

  const hasDynamic =
    hasStreaming || pendingSteerMessages.length > 0 || queuedInputMessages.length > 0;

  // The live region must never grow taller than the viewport: a frame taller
  // than the pane breaks Ink's in-place redraw under tmux (the cursor-up clear
  // can't reach scrolled-off rows), leaving large blank gaps + stray glyphs.
  // Clip it to maxStreamRows and pin to the bottom so the user sees the latest
  // output (tail view); the full turn lands in <Static> scrollback on commit.
  const clampDynamic = typeof maxStreamRows === "number" && maxStreamRows > 0;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Settled rows are committed once to the terminal's native scrollback.
          Ink never repaints <Static> output, so scrolling up to read history
          (or selecting/copying it) is the terminal's job — zero app repaint,
          zero flicker. The key discards prior output on a non-monotonic
          rebuild (see staticGeneration). */}
      <Static items={staticItems} key={`transcript-${staticGeneration}`}>
        {(item) => {
          if (item.kind === "welcome") {
            return (
              <Box key={item.key} flexDirection="column" paddingX={paddingX}>
                {welcomeBanner}
              </Box>
            );
          }
          return (
            <Box key={item.key} flexDirection="column" paddingX={paddingX}>
              <MessageItem
                message={item.message}
                terminalColumns={terminalColumns}
                showThinking={showThinking}
                expandedToolOutput={expandedToolOutput}
                verboseTrace={verboseTrace}
                showExpandHint={item.showExpandHint}
                separateFromPrevious={item.separateFromPrevious}
              />
            </Box>
          );
        }}
      </Static>
      {/* The dynamic region: only the in-progress turn + queued/steer hints
          live here and repaint as tokens arrive. Kept short so the repaint is
          cheap and flicker-free even on tmux / non-GPU terminals. */}
      {hasDynamic && (
        <DynamicClamp maxRows={clampDynamic ? maxStreamRows : undefined} paddingX={paddingX}>
          {hasStreaming && (
            <StreamingMessage
              content={streamingContent}
              reasoning={streamingReasoning}
              tools={streamingTools}
              parts={streamingParts}
              terminalColumns={terminalColumns}
              showThinking={showThinking}
              expandedToolOutput={expandedToolOutput}
              verboseTrace={verboseTrace}
              pendingApproval={pendingApproval}
              nowTick={nowTick}
            />
          )}
          {pendingSteerMessages.length > 0 && (
            <PendingInputMessagesBlock
              messages={pendingSteerMessages}
              terminalColumns={terminalColumns}
              title="Messages to steer at next model call"
              hint="applies before the next provider request"
              bulletColor={theme.warning}
            />
          )}
          {queuedInputMessages.length > 0 && (
            <PendingInputMessagesBlock
              messages={queuedInputMessages}
              terminalColumns={terminalColumns}
              title="Messages queued for next turn"
              hint="runs after the current answer"
              bulletColor={theme.muted}
            />
          )}
        </DynamicClamp>
      )}
    </Box>
  );
}

/**
 * Bounds the live (in-progress turn) region to at most `maxRows` rows, pinned
 * to the bottom so the user always sees the latest output (tail view). A live
 * frame taller than the terminal pane breaks Ink's in-place redraw under tmux
 * (the cursor-up clear can't reach rows that scrolled off), leaving large blank
 * gaps and stray glyphs. We measure the natural content height and only clip
 * when it actually exceeds `maxRows`, so short turns keep their natural height
 * (no reserved-space gap). The full turn still lands in <Static> scrollback the
 * moment it commits, so nothing is lost — only the live preview is windowed.
 */
function DynamicClamp({
  maxRows,
  paddingX,
  children,
}: {
  maxRows?: number;
  paddingX: number;
  children: React.ReactNode;
}) {
  const innerRef = React.useRef<DOMElement | null>(null);
  const [offset, setOffset] = React.useState(0);
  const [clipHeight, setClipHeight] = React.useState<number | undefined>(undefined);

  // Re-measure after every commit (streaming changes height with each token).
  // useLayoutEffect runs before Ink flushes the frame to the terminal, so the
  // clamp is applied in the same paint — avoiding a one-frame overflow flash
  // under tmux when a turn first grows past the pane. setState bails out via
  // Object.is when nothing moved, so the steady state does not loop.
  React.useLayoutEffect(() => {
    if (!maxRows || !innerRef.current) {
      if (offset !== 0) setOffset(0);
      if (clipHeight !== undefined) setClipHeight(undefined);
      return;
    }
    const height = measureElement(innerRef.current).height;
    if (height > maxRows) {
      const nextOffset = -(height - maxRows);
      if (nextOffset !== offset) setOffset(nextOffset);
      if (clipHeight !== maxRows) setClipHeight(maxRows);
    } else {
      if (offset !== 0) setOffset(0);
      if (clipHeight !== undefined) setClipHeight(undefined);
    }
  });

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingX={paddingX}
      {...(clipHeight !== undefined ? { height: clipHeight, overflowY: "hidden" as const } : {})}
    >
      <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={offset}>
        {children}
      </Box>
    </Box>
  );
}

// Memoized: with no <Static> region, every transcript row re-renders on each
// state change unless its props are referentially stable. Message objects are
// append-only (compaction reuses already-compacted instances), keys are
// stable, and nowTick is only threaded to the last row, so memo hits for all
// settled history rows.
const MessageItem = React.memo(function MessageItem({
  message,
  terminalColumns,
  showThinking,
  expandedToolOutput,
  verboseTrace,
  showExpandHint,
  separateFromPrevious,
  nowTick,
}: {
  message: DisplayMessage;
  terminalColumns: number;
  showThinking: boolean;
  expandedToolOutput: boolean;
  verboseTrace: boolean;
  showExpandHint: boolean;
  separateFromPrevious: boolean;
  nowTick?: number;
}) {
  const theme = useTheme();
  if (message.role === "user") {
    return (
      <UserMessageBlock
        content={message.content}
        terminalColumns={terminalColumns}
        inputStatus={message.inputStatus}
        separateFromPrevious={separateFromPrevious}
      />
    );
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

  if (message.syntheticKind === "ui_interrupt") {
    return (
      <Box marginBottom={1}>
        <Text color={theme.error}>⏹ </Text>
        <Text color={theme.muted} dimColor>{message.content || "Interrupted by user"}</Text>
      </Box>
    );
  }

  const visibleReasoning = sanitizeInternalReminderBlocks(message.reasoning ?? "").trim();
  const hasVisibleAssistantContent =
    !!message.content ||
    (message.toolCalls?.length ?? 0) > 0 ||
    (message.parts?.length ?? 0) > 0 ||
    (!!visibleReasoning && (showThinking || verboseTrace));
  if (!hasVisibleAssistantContent) return null;

  return (
    <Box marginTop={1} marginBottom={1} flexDirection="column">
      {visibleReasoning && (showThinking || verboseTrace) && <ReasoningTraceBlock reasoning={visibleReasoning} />}
      {message.parts && message.parts.length > 0 ? (
        <MessageParts
          parts={message.parts}
          terminalColumns={terminalColumns}
          expandedToolOutput={expandedToolOutput}
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
              expandedToolOutput={expandedToolOutput}
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
});

function StreamingMessage({
  content,
  reasoning,
  tools,
  parts,
  terminalColumns,
  showThinking,
  expandedToolOutput,
  verboseTrace,
  pendingApproval,
  nowTick,
}: {
  content: string;
  reasoning: string;
  tools: DisplayToolCall[];
  parts: DisplayMessagePart[];
  terminalColumns: number;
  showThinking: boolean;
  expandedToolOutput: boolean;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  nowTick?: number;
}) {
  const deferredContent = React.useDeferredValue(content);
  const deferredReasoning = React.useDeferredValue(reasoning);
  const deferredParts = React.useDeferredValue(parts);
  const visibleReasoning = sanitizeInternalReminderBlocks(deferredReasoning).trim();
  const visibleParts = deferredParts.length > 0
    ? deferredParts
    : fallbackStreamingParts(deferredContent, tools);

  return (
    <Box flexDirection="column">
      {visibleReasoning && (showThinking || verboseTrace) && (
        <Box marginTop={1} flexDirection="column">
          <ReasoningTraceBlock reasoning={visibleReasoning} />
        </Box>
      )}
      {visibleParts.length > 0 && (
        // marginTop=1 matches the committed MessageItem layout exactly, so the
        // gap under the user message is identical while streaming and after the
        // turn commits — no spacing jump at finalize time. (The old marginTop=0
        // was a flicker mitigation for the main-screen <Static> renderer; the
        // alt-screen viewport repaints frames atomically, so it's obsolete.)
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          <MessageParts
            parts={visibleParts}
            terminalColumns={terminalColumns}
            expandedToolOutput={expandedToolOutput}
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
  expandedToolOutput,
  verboseTrace,
  pendingApproval,
  showExpandHint,
  nowTick,
  showActivity = false,
  streaming = false,
}: {
  parts: DisplayMessagePart[];
  terminalColumns: number;
  expandedToolOutput: boolean;
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
            expandedToolOutput={expandedToolOutput}
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
  // marginLeft (2) + "●  " marker (3 visual cells) = 5 cells consumed by the
  // timeline gutter; pass the remaining width so wide blocks like tables size
  // themselves against the actual content area instead of the raw terminal.
  const available = terminalColumns ? Math.max(20, terminalColumns - 5) : undefined;
  const trimmed = content.trim();
  return (
    <Box marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Text color={theme.agent}>●  </Text>
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
  expandedToolOutput,
  verboseTrace,
  pendingApproval,
  showExpandHint,
  compactTop = false,
  nowTick,
  showActivity = false,
}: {
  toolCalls: DisplayToolCall[];
  terminalColumns: number;
  expandedToolOutput: boolean;
  verboseTrace: boolean;
  pendingApproval?: PendingApprovalHint | null;
  showExpandHint: boolean;
  compactTop?: boolean;
  nowTick?: number;
  showActivity?: boolean;
}) {
  if (toolCalls.length === 0) return null;
  const expandTools = verboseTrace || expandedToolOutput;
  if (!expandTools) {
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
          isToolPending(tc) && !!pendingApproval && approvalMatchesTool(pendingApproval, tc);
        return (
          <ToolCallDisplay
            key={tc.id}
            toolCall={tc}
            isStreaming={isToolPending(tc)}
            verbose={expandTools}
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
  // A model-provided bash description owns the header slot; the command then
  // always renders as a block below. Without one, single-line commands that
  // fit stay inline; anything longer becomes a wrapped block preserving the
  // command's own line structure — commands are never clipped mid-line.
  const showDescription = group.kind === "execute" && !!group.description;
  const inlineCommand = !showDescription && group.command
    ? (group.kind === "execute"
        ? (shouldInlineExecuteCommand(group, commandWidth) ? group.command : undefined)
        : (visualWidth(group.command) <= commandWidth ? group.command : undefined))
    : undefined;
  const commandBlock = group.command && !inlineCommand
    ? (group.kind === "execute"
        ? executeCommandBlock(group, EXECUTE_COMMAND_BLOCK_MAX_LINES)
        : { lines: [group.command], omitted: 0 })
    : null;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Text>
        <Text bold color={titleColor}>{group.title}</Text>
        {showDescription ? (
          <Text color={theme.traceDetail}> {truncateVisual(group.description!, commandWidth)}</Text>
        ) : inlineCommand ? (
          <Text color={theme.traceCommand}> {inlineCommand}</Text>
        ) : !group.command && group.count !== undefined && group.noun ? (
          <Text color={theme.traceCount}> {group.count} {group.noun}</Text>
        ) : null}
        {status && <Text color={status.color}> {status.text}</Text>}
      </Text>
      {commandBlock && commandBlock.lines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {commandBlock.lines.flatMap((line, idx) =>
            wrapByVisualWidth(line || " ", Math.max(10, detailWidth - 2)).map((seg, segIdx) => (
              <Text key={`cmd-${idx}-${segIdx}`} color={theme.traceCommand}>{seg}</Text>
            )),
          )}
          {commandBlock.omitted > 0 && (
            <Text color={theme.traceDetail}>
              … {commandBlock.omitted} more line{commandBlock.omitted === 1 ? "" : "s"}
            </Text>
          )}
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
    (tool) => isToolPending(tool) && approvalMatchesTool(pendingApproval, tool),
  );
}

function approvalMatchesTool(hint: PendingApprovalHint, tc: DisplayToolCall): boolean {
  if (hint.toolName !== tc.name) return false;
  if (hint.toolName === "bash") {
    return !hint.command || hint.command === tc.args.command;
  }
  return !hint.path || hint.path === tc.args.path;
}

function isToolPending(tool: DisplayToolCall): boolean {
  return tool.result === undefined && tool.resultCollapsed !== true;
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

function UserMessageBlock({
  content,
  terminalColumns,
  inputStatus,
  separateFromPrevious = false,
}: {
  content: string;
  terminalColumns: number;
  inputStatus?: UserInputStatus;
  separateFromPrevious?: boolean;
}) {
  const theme = useTheme();
  const badge = userInputStatusBadgeLabel(inputStatus);
  // Rail and its right gutter must share the bubble background; otherwise the
  // terminal background shows up as a dark seam between rail and message.
  const railWidth = 2;
  const horizontalRoom = Math.max(20, terminalColumns - 2);
  const bubbleTextWidth = Math.max(1, horizontalRoom - railWidth - 2);
  const { bodyLines, referenceLines } = splitImageDisplayContent(content);
  const wrappedLines = bodyLines
    .flatMap((line) => wrapByVisualWidth(line, bubbleTextWidth));
  const attachmentReferenceIndent = " ".repeat(railWidth + 1);

  return (
    <Box flexDirection="column" marginTop={separateFromPrevious ? 1 : 0}>
      {badge && (
        <Box>
          <Text bold color={inputStatus === "pending_steer" ? theme.warning : theme.muted}>
            {` ${badge} `}
          </Text>
          <Text color={theme.dim}>
            {inputStatus === "pending_steer" ? "applies at the next model call" : "runs after this turn"}
          </Text>
        </Box>
      )}
      {wrappedLines.map((line, index) => (
        <Box key={index}>
          {/* Draw the rail on every wrapped row so the bar spans the full
              height of a multi-line message instead of only the first line.
              "▌" is a left half-block, so stacked rows form one continuous bar. */}
          <Text backgroundColor={theme.userMessageBg} color={theme.userRail}>
            {"▌ "}
          </Text>
          <Text backgroundColor={theme.userMessageBg} color={theme.userMessageText}>
            {` ${padVisual(line || " ", bubbleTextWidth)} `}
          </Text>
        </Box>
      ))}
      {referenceLines.map((line, index) => (
        <Box key={`attachment-${index}`}>
          <Text color={theme.muted}>{`${attachmentReferenceIndent}${line}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

function PendingInputMessagesBlock({
  messages,
  terminalColumns,
  title,
  hint,
  bulletColor,
}: {
  messages: DisplayMessage[];
  terminalColumns: number;
  title: string;
  hint: string;
  bulletColor: string;
}) {
  const theme = useTheme();
  const contentWidth = Math.max(20, terminalColumns - 5);

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={bulletColor}>• </Text>
        <Text bold color={theme.inputText}>{title} </Text>
        <Text color={theme.dim}>({hint})</Text>
      </Box>
      {messages.flatMap((message, messageIndex) => {
        const { bodyLines, referenceLines } = splitImageDisplayContent(message.content || " ");
        const wrappedBody = bodyLines.flatMap((line) =>
          wrapByVisualWidth(line || " ", contentWidth),
        );
        const bodyRows = wrappedBody.map((line, lineIndex) => (
          <Box key={`body-${message.key ?? messageIndex}-${lineIndex}`} marginLeft={2}>
            <Text color={theme.dim}>{lineIndex === 0 ? "↳ " : "  "}</Text>
            <Text color={theme.inputText}>{line}</Text>
          </Box>
        ));
        const attachmentRows = referenceLines.map((line, lineIndex) => (
          <Box key={`attachment-${message.key ?? messageIndex}-${lineIndex}`} marginLeft={2}>
            <Text color={theme.dim}>  {line}</Text>
          </Box>
        ));
        return [...bodyRows, ...attachmentRows];
      })}
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
  if (tc.resultCollapsed) return tc.isError ? "error output collapsed" : "result collapsed";
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
  } else if (isToolPending(toolCall) && toolCall.startedAt) {
    void nowTick;
    summary = "running";
    summaryColor = theme.toolPending;
  } else {
    summary = summarizeToolResult(toolCall);
    if (toolCall.isError) summaryColor = theme.error;
    else if (toolCall.name === "edit" && toolCall.result !== undefined) summaryColor = theme.success;
  }

  const editDetails = getEditDiffDetails(toolCall);
  const isEditDiff = editDetails !== null && toolCall.result !== undefined && !toolCall.resultCollapsed;
  const showSummary = !toolCall.resultCollapsed || waitingApproval;
  // Only show the file preview once the tool actually executed. During the
  // streaming-args phase, args.content is incomplete and re-rendering the
  // entire body per delta both looks chaotic and breaks on partial escapes.
  const isWritePreview = toolCall.name === "write" && !toolCall.isError && toolCall.result !== undefined && !toolCall.resultCollapsed;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={compactTop ? 0 : 1}>
      <Box>
        <Text color={bulletColor}>{glyph} </Text>
        <Text bold color={theme.toolName}>{name}</Text>
        {header && <Text color={theme.muted}>({header})</Text>}
      </Box>
      {showSummary && (
        <Box marginLeft={2}>
          <Text color={summaryColor}>⎿  {summary}</Text>
        </Box>
      )}
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
  const bulletColor = hasError ? theme.error : isToolPending(toolCall) ? theme.toolPending : theme.user;
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

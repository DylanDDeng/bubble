/** @jsxImportSource @opentui/react */
import React from "react";
import { useTheme, type Theme } from "./theme.js";
import { MarkdownContent, StreamingMarkdown } from "./markdown.js";
import type { DisplayMessage, DisplayMessagePart, DisplayToolCall } from "./display-history.js";
import { EDIT_COLLAPSED_DIFF_LINES, getEditDiffDetails } from "./edit-diff.js";
import { sanitizeInternalReminderBlocks } from "../agent/internal-reminder-sanitizer.js";

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
  nowTick?: number;
  welcomeBanner?: React.ReactNode;
}

/**
 * Scrollback-style message list following opencode visual rules:
 *
 *  - User messages: `›` (U+203A) prefix in accent color, plain text body
 *  - Assistant messages: full-width body in `theme.text`, no chrome
 *  - Reasoning: `Thinking:` prefix in textMuted
 *  - Tools: dim title row + paddingLeft=1 body
 *  - No borders, no bubbles, no role badges — everything is text rhythm
 */
export function MessageList({
  messages,
  streamingContent,
  streamingReasoning,
  streamingTools,
  streamingParts,
  terminalColumns,
  verboseTrace,
  welcomeBanner,
}: MessageListProps) {
  const hasStreaming = !!(
    streamingContent ||
    streamingReasoning ||
    streamingTools.length > 0 ||
    streamingParts.length > 0
  );

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {welcomeBanner}
      {messages.map((msg, i) => (
        <MessageItem
          key={msg.key ?? `message-${i}`}
          message={msg}
          terminalColumns={terminalColumns}
          verboseTrace={verboseTrace}
        />
      ))}
      {hasStreaming && (
        <StreamingMessage
          content={streamingContent}
          reasoning={streamingReasoning}
          tools={streamingTools}
          parts={streamingParts}
          terminalColumns={terminalColumns}
          verboseTrace={verboseTrace}
        />
      )}
    </box>
  );
}

function MessageItem({
  message,
  terminalColumns,
  verboseTrace,
}: {
  message: DisplayMessage;
  terminalColumns: number;
  verboseTrace: boolean;
}) {
  const theme = useTheme();
  if (message.role === "user") {
    return <UserMessageBlock content={message.content} theme={theme} />;
  }

  if (message.role === "error") {
    return (
      <box style={{ marginBottom: 1, flexDirection: "column" }}>
        <text fg={theme.error} content={`Error: ${message.content}`} />
      </box>
    );
  }

  if (message.syntheticKind === "ui_compact_summary") {
    return <CompactionSummaryBlock message={message} theme={theme} />;
  }

  const visibleReasoning = sanitizeInternalReminderBlocks(message.reasoning ?? "").trim();
  const hasVisible =
    !!message.content ||
    (message.toolCalls?.length ?? 0) > 0 ||
    (message.parts?.length ?? 0) > 0 ||
    (!!visibleReasoning && verboseTrace);
  if (!hasVisible) return null;

  return (
    <box style={{ marginTop: 1, marginBottom: 1, flexDirection: "column" }}>
      {visibleReasoning && verboseTrace && <ReasoningBlock reasoning={visibleReasoning} theme={theme} />}
      {message.parts && message.parts.length > 0 ? (
        <MessageParts parts={message.parts} terminalColumns={terminalColumns} verboseTrace={verboseTrace} theme={theme} />
      ) : (
        <>
          {message.toolCalls && <ToolsPart toolCalls={message.toolCalls} terminalColumns={terminalColumns} verboseTrace={verboseTrace} theme={theme} />}
          {message.content && <MarkdownContent content={message.content} terminalColumns={terminalColumns} />}
        </>
      )}
    </box>
  );
}

function StreamingMessage({
  content,
  reasoning,
  tools,
  parts,
  terminalColumns,
  verboseTrace,
}: {
  content: string;
  reasoning: string;
  tools: DisplayToolCall[];
  parts: DisplayMessagePart[];
  terminalColumns: number;
  verboseTrace: boolean;
}) {
  const theme = useTheme();
  const visibleReasoning = sanitizeInternalReminderBlocks(reasoning).trim();
  const visibleParts = parts.length > 0 ? parts : fallbackStreamingParts(content, tools);
  return (
    <box style={{ flexDirection: "column", marginTop: 1 }}>
      {visibleReasoning && verboseTrace && <ReasoningBlock reasoning={visibleReasoning} theme={theme} />}
      {visibleParts.length > 0 && (
        <MessageParts parts={visibleParts} terminalColumns={terminalColumns} verboseTrace={verboseTrace} streaming theme={theme} />
      )}
    </box>
  );
}

function fallbackStreamingParts(content: string, tools: DisplayToolCall[]): DisplayMessagePart[] {
  const out: DisplayMessagePart[] = [];
  if (tools.length > 0) out.push({ type: "tools", toolCalls: tools });
  if (content) out.push({ type: "text", content });
  return out;
}

function MessageParts({
  parts,
  terminalColumns,
  verboseTrace,
  streaming = false,
  theme,
}: {
  parts: DisplayMessagePart[];
  terminalColumns: number;
  verboseTrace: boolean;
  streaming?: boolean;
  theme: Theme;
}) {
  return (
    <box style={{ flexDirection: "column" }}>
      {parts.map((part, idx) => {
        if (part.type === "text") {
          if (streaming && idx === parts.length - 1) {
            return <StreamingMarkdown key={`text-${idx}`} content={part.content} terminalColumns={terminalColumns} />;
          }
          return <MarkdownContent key={`text-${idx}`} content={part.content} terminalColumns={terminalColumns} />;
        }
        return <ToolsPart key={`tools-${idx}`} toolCalls={part.toolCalls} terminalColumns={terminalColumns} verboseTrace={verboseTrace} theme={theme} />;
      })}
    </box>
  );
}

/**
 * User message: `›` prefix in accent color, body in accent color. No border
 * or background — flows in scrollback as raw colored text. opencode pattern.
 */
function UserMessageBlock({ content, theme }: { content: string; theme: Theme }) {
  const lines = content.split("\n");
  return (
    <box style={{ marginTop: 1, marginBottom: 1, flexDirection: "column" }}>
      {lines.map((line, i) => (
        <text key={`u-${i}`} fg={theme.userMessageText}>
          {i === 0 ? "› " : "  "}
          {line || " "}
        </text>
      ))}
    </box>
  );
}

function ReasoningBlock({ reasoning, theme }: { reasoning: string; theme: Theme }) {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      {reasoning.split("\n").map((line, i) => (
        <text key={`r-${i}`} fg={theme.textMuted}>
          {i === 0 ? "Thinking: " : "          "}
          {line}
        </text>
      ))}
    </box>
  );
}

function CompactionSummaryBlock({ message, theme }: { message: DisplayMessage; theme: Theme }) {
  return (
    <box style={{ flexDirection: "column", marginTop: 1, marginBottom: 1 }}>
      <text fg={theme.textMuted} attributes={1} content="── context compacted ──" />
      {message.content && (
        <text fg={theme.textMuted} content={message.content} />
      )}
    </box>
  );
}

function ToolsPart({
  toolCalls,
  terminalColumns,
  verboseTrace,
  theme,
}: {
  toolCalls: DisplayToolCall[];
  terminalColumns: number;
  verboseTrace: boolean;
  theme: Theme;
}) {
  return (
    <box style={{ flexDirection: "column", marginTop: 1 }}>
      {toolCalls.map((tc) => (
        <ToolCard key={tc.id} tool={tc} terminalColumns={terminalColumns} verboseTrace={verboseTrace} theme={theme} />
      ))}
    </box>
  );
}

/**
 * Tool card: dim title line + indented body. No icons, no per-tool colors —
 * pure text rhythm so the eye reads the header as a section break and the
 * body as content. Matches opencode's `theme.block` pattern.
 */
function ToolCard({
  tool,
  terminalColumns,
  verboseTrace,
  theme,
}: {
  tool: DisplayToolCall;
  terminalColumns: number;
  verboseTrace: boolean;
  theme: Theme;
}) {
  const pending = isToolPending(tool);
  const error = tool.isError;
  const target = describeToolTarget(tool);
  const headerColor = pending ? theme.toolPending : error ? theme.toolError : theme.textMuted;
  const titleText = target ? `${tool.name}  ${target}` : tool.name;

  const editDetails = (tool.name === "edit" || tool.name === "apply_patch" || tool.name === "multiedit" || tool.name === "write")
    ? getEditDiffDetails(tool)
    : null;

  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <text fg={headerColor} content={titleText} />
      <box style={{ paddingLeft: 1, flexDirection: "column" }}>
        {!pending && tool.result && verboseTrace && (
          <ToolResultPreview result={tool.result} error={error} terminalColumns={terminalColumns} theme={theme} />
        )}
        {!tool.resultCollapsed && editDetails && editDetails.diff && (
          <EditDiffPreview diff={editDetails.diff} theme={theme} />
        )}
      </box>
    </box>
  );
}

function isToolPending(tool: DisplayToolCall): boolean {
  return tool.result === undefined && tool.resultCollapsed !== true;
}

function describeToolTarget(tool: DisplayToolCall): string {
  const args = tool.args || {};
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") return args.command.slice(0, 80);
  if (typeof args.pattern === "string") return args.pattern;
  if (typeof args.url === "string") return args.url;
  if (typeof args.query === "string") return args.query;
  return "";
}

function ToolResultPreview({
  result,
  error,
  terminalColumns,
  theme,
}: {
  result: string;
  error?: boolean;
  terminalColumns: number;
  theme: Theme;
}) {
  const lines = result.split("\n").slice(0, 8);
  const maxLen = Math.max(20, terminalColumns - 8);
  return (
    <box style={{ flexDirection: "column" }}>
      {lines.map((line, i) => (
        <text
          key={`r-${i}`}
          fg={error ? theme.toolError : theme.text}
          content={line.length > maxLen ? line.slice(0, maxLen - 1) + "…" : line}
        />
      ))}
    </box>
  );
}

function EditDiffPreview({ diff, theme }: { diff: string; theme: Theme }) {
  const allLines = diff.split("\n");
  const shown = allLines.slice(0, EDIT_COLLAPSED_DIFF_LINES);
  const overflow = allLines.length - shown.length;
  return (
    <box style={{ flexDirection: "column" }}>
      {shown.map((line, i) => {
        const kind = line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ";
        const fg = kind === "+" ? theme.diffAddFg : kind === "-" ? theme.diffRemoveFg : theme.textMuted;
        return <text key={`d-${i}`} fg={fg} content={line} />;
      })}
      {overflow > 0 && <text fg={theme.textMuted} content={`  … +${overflow} more lines`} />}
    </box>
  );
}

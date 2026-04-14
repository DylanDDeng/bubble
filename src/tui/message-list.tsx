import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { highlightCode, inferLang } from "./code-highlight.js";
import { MarkdownContent } from "./markdown.js";

export interface DisplayMessage {
  role: "user" | "assistant" | "error";
  content: string;
  reasoning?: string;
  toolCalls?: DisplayToolCall[];
}

export interface DisplayToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: string;
  isError?: boolean;
}

interface MessageListProps {
  messages: DisplayMessage[];
  streamingContent: string;
  streamingReasoning: string;
  streamingTools: DisplayToolCall[];
}

export function MessageList({ messages, streamingContent, streamingReasoning, streamingTools }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageItem key={i} message={msg} />
      ))}
      {(streamingContent || streamingReasoning || streamingTools.length > 0) && (
        <StreamingMessage content={streamingContent} reasoning={streamingReasoning} tools={streamingTools} />
      )}
    </Box>
  );
}

function MessageItem({ message }: { message: DisplayMessage }) {
  if (message.role === "user") {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text bold color={theme.user}>You</Text>
        <Text>{message.content}</Text>
      </Box>
    );
  }

  if (message.role === "error") {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text color={theme.error}>Error: {message.content}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold color={theme.agent}>Agent</Text>
      {message.reasoning && <ThinkingBlock reasoning={message.reasoning} />}
      {message.toolCalls?.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} />
      ))}
      {message.content && <MarkdownContent content={message.content} />}
    </Box>
  );
}

function StreamingMessage({ content, reasoning, tools }: { content: string; reasoning: string; tools: DisplayToolCall[] }) {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold color={theme.agent}>Agent</Text>
      {reasoning && <ThinkingBlock reasoning={reasoning} />}
      {tools.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} isStreaming={!tc.result} />
      ))}
      {content && <Text>{content}</Text>}
    </Box>
  );
}

function ThinkingBlock({ reasoning }: { reasoning: string }) {
  const lines = reasoning.split("\n").filter((l) => l.trim() !== "");
  const preview = lines.slice(0, 3);
  const hasMore = lines.length > 3;
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color={theme.thinking} bold>Thinking</Text>
      {preview.map((line, i) => (
        <Text key={i} color={theme.thinking}>
          {line}
        </Text>
      ))}
      {hasMore && <Text color={theme.thinking}>... ({lines.length - 3} more lines)</Text>}
    </Box>
  );
}

function getToolHeader(toolCall: DisplayToolCall): string | undefined {
  if (toolCall.name === "read" || toolCall.name === "write" || toolCall.name === "edit") {
    return toolCall.args.path;
  }
  if (toolCall.name === "bash" && toolCall.args.command) {
    const cmd = String(toolCall.args.command).replace(/\n/g, " ");
    return cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
  }
  return undefined;
}

function ToolCallDisplay({ toolCall, isStreaming }: { toolCall: DisplayToolCall; isStreaming?: boolean }) {
  const [formatted, setFormatted] = React.useState<{ lines: string[]; remaining: number } | null>(null);
  const header = getToolHeader(toolCall);

  React.useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!toolCall.result) return;

      const maxLines = toolCall.name === "read" || toolCall.name === "edit" ? 12 : 8;
      const raw = toolCall.result.replace(/\r\n/g, "\n");
      let lang = "text";

      if (toolCall.name === "read") lang = inferLang(toolCall.args.path);
      else if (toolCall.name === "edit") lang = "diff";
      else if (toolCall.name === "bash") lang = "shell";

      let highlighted = raw;
      if (lang !== "text" && !toolCall.isError) {
        try {
          highlighted = await highlightCode(raw, lang);
        } catch {
          // fallback to plain text
        }
      }

      const allLines = highlighted.split("\n");
      const lines = allLines.slice(0, maxLines);
      const remaining = Math.max(0, allLines.length - maxLines);

      if (!cancelled) {
        setFormatted({ lines, remaining });
      }
    }

    // Show plain text immediately while highlighting is in progress
    if (toolCall.result) {
      const maxLines = toolCall.name === "read" || toolCall.name === "edit" ? 12 : 8;
      const plainLines = toolCall.result.replace(/\r\n/g, "\n").split("\n");
      setFormatted({
        lines: plainLines.slice(0, maxLines),
        remaining: Math.max(0, plainLines.length - maxLines),
      });
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [toolCall.result, toolCall.name, toolCall.args.path, toolCall.isError]);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color={theme.muted}>{isStreaming ? "▶ " : "✓ "}</Text>
        <Text bold color={theme.toolName}>{toolCall.name}</Text>
        {header && <Text color={theme.muted}> {header}</Text>}
      </Box>
      {toolCall.isError && toolCall.result && (
        <Box marginLeft={2} flexDirection="column">
          {toolCall.result.replace(/\r\n/g, "\n").split("\n").slice(0, 6).map((line, i) => (
            <Text key={i} color={theme.error}>{line}</Text>
          ))}
        </Box>
      )}
      {!toolCall.isError && formatted && (
        <Box flexDirection="column" marginLeft={2}>
          {formatted.lines.map((line, i) => (
            <Box key={i}>
              <Text color={theme.muted}>│ </Text>
              <Text>{line}</Text>
            </Box>
          ))}
          {formatted.remaining > 0 && (
            <Text color={theme.muted}>... ({formatted.remaining} more lines)</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

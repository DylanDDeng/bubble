import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

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
      {message.content && <Text>{message.content}</Text>}
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

function ToolCallDisplay({ toolCall, isStreaming }: { toolCall: DisplayToolCall; isStreaming?: boolean }) {
  const resultPreview = toolCall.result
    ? toolCall.result.replace(/\n/g, " ").slice(0, 80) + (toolCall.result.length > 80 ? "..." : "")
    : undefined;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color={theme.muted}>{isStreaming ? "▶ " : "✓ "}</Text>
        <Text bold color={theme.toolName}>{toolCall.name}</Text>
      </Box>
      {resultPreview && (
        <Box marginLeft={2}>
          <Text color={toolCall.isError ? theme.toolError : theme.toolResult}>
            {toolCall.isError ? `Error: ${resultPreview}` : resultPreview}
          </Text>
        </Box>
      )}
    </Box>
  );
}

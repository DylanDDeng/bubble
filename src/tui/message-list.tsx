import React from "react";
import { Box, Text } from "ink";

export interface DisplayMessage {
  role: "user" | "assistant" | "error";
  content: string;
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
  streamingTools: DisplayToolCall[];
}

export function MessageList({ messages, streamingContent, streamingTools }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageItem key={i} message={msg} />
      ))}
      {(streamingContent || streamingTools.length > 0) && (
        <StreamingMessage content={streamingContent} tools={streamingTools} />
      )}
    </Box>
  );
}

function MessageItem({ message }: { message: DisplayMessage }) {
  if (message.role === "user") {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="green">You</Text>
        <Text>{message.content}</Text>
      </Box>
    );
  }

  if (message.role === "error") {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text color="red">Error: {message.content}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold color="blue">Agent</Text>
      {message.content && <Text>{message.content}</Text>}
      {message.toolCalls?.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} />
      ))}
    </Box>
  );
}

function StreamingMessage({ content, tools }: { content: string; tools: DisplayToolCall[] }) {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold color="blue">Agent</Text>
      {content && <Text>{content}</Text>}
      {tools.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} isStreaming={!tc.result} />
      ))}
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
        <Text dimColor>{isStreaming ? "▶ " : "✓ "}</Text>
        <Text bold color="cyan">{toolCall.name}</Text>
      </Box>
      {resultPreview && (
        <Box marginLeft={2}>
          <Text dimColor color={toolCall.isError ? "red" : undefined}>
            {toolCall.isError ? `Error: ${resultPreview}` : resultPreview}
          </Text>
        </Box>
      )}
    </Box>
  );
}

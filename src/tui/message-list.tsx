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
  terminalColumns: number;
}

export function MessageList({ messages, streamingContent, streamingReasoning, streamingTools, terminalColumns }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageItem key={i} message={msg} terminalColumns={terminalColumns} />
      ))}
      {(streamingContent || streamingReasoning || streamingTools.length > 0) && (
        <StreamingMessage content={streamingContent} reasoning={streamingReasoning} tools={streamingTools} />
      )}
    </Box>
  );
}

function MessageItem({ message, terminalColumns }: { message: DisplayMessage; terminalColumns: number }) {
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

  return (
    <Box marginBottom={1} flexDirection="column">
      {message.reasoning && <ThinkingBlock reasoning={message.reasoning} />}
      {message.toolCalls?.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} />
      ))}
      {message.content && <MarkdownContent content={message.content} />}
    </Box>
  );
}

function StreamingMessage({ content, reasoning, tools }: { content: string; reasoning: string; tools: DisplayToolCall[] }) {
  const deferredContent = React.useDeferredValue(content);
  const deferredReasoning = React.useDeferredValue(reasoning);

  return (
    <Box marginBottom={1} flexDirection="column">
      {deferredReasoning && <ThinkingBlock reasoning={deferredReasoning} />}
      {tools.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} isStreaming={!tc.result} />
      ))}
      {deferredContent && <MarkdownContent content={deferredContent} />}
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

function UserMessageBlock({ content, terminalColumns }: { content: string; terminalColumns: number }) {
  const horizontalPadding = 2;
  const width = Math.max(20, terminalColumns - 2);
  const contentWidth = Math.max(1, width - horizontalPadding * 2);
  const wrappedLines = content.split("\n").flatMap((line) => wrapByVisualWidth(line, contentWidth));
  const paddedLines = ["", ...wrappedLines, ""];

  return (
    <Box marginBottom={1} flexDirection="column">
      <Box flexDirection="column">
        {paddedLines.map((line, index) => (
          <Text
            key={index}
            backgroundColor={theme.userMessageBg}
            color={theme.userMessageText}
          >
            {" ".repeat(horizontalPadding)}
            {padVisual(line || " ", contentWidth)}
            {" ".repeat(horizontalPadding)}
          </Text>
        ))}
      </Box>
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

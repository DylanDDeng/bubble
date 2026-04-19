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
  verboseTrace: boolean;
}

export function MessageList({ messages, streamingContent, streamingReasoning, streamingTools, terminalColumns, verboseTrace }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageItem key={i} message={msg} terminalColumns={terminalColumns} verboseTrace={verboseTrace} />
      ))}
      {(streamingContent || streamingReasoning || streamingTools.length > 0) && (
        <StreamingMessage content={streamingContent} reasoning={streamingReasoning} tools={streamingTools} terminalColumns={terminalColumns} />
      )}
    </Box>
  );
}

function MessageItem({ message, terminalColumns, verboseTrace }: { message: DisplayMessage; terminalColumns: number; verboseTrace: boolean }) {
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
      {message.reasoning && <ThinkingBlock reasoning={message.reasoning} verbose={verboseTrace} />}
      {message.toolCalls?.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} verbose={verboseTrace} terminalColumns={terminalColumns} />
      ))}
      {message.content && <MarkdownContent content={message.content} />}
    </Box>
  );
}

function StreamingMessage({ content, reasoning, tools, terminalColumns }: { content: string; reasoning: string; tools: DisplayToolCall[]; terminalColumns: number }) {
  const deferredContent = React.useDeferredValue(content);
  const deferredReasoning = React.useDeferredValue(reasoning);

  return (
    <Box marginBottom={1} flexDirection="column">
      {deferredReasoning && <ThinkingBlock reasoning={deferredReasoning} verbose />}
      {tools.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} isStreaming={!tc.result} verbose terminalColumns={terminalColumns} />
      ))}
      {deferredContent && <MarkdownContent content={deferredContent} />}
    </Box>
  );
}

function ThinkingBlock({ reasoning, verbose }: { reasoning: string; verbose: boolean }) {
  const lines = reasoning.split("\n").filter((l) => l.trim() !== "");
  const shown = verbose ? lines : lines.slice(0, 3);
  const hiddenCount = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color={theme.thinking} bold>Thinking</Text>
      {shown.map((line, i) => (
        <Text key={i} color={theme.thinking}>
          {line}
        </Text>
      ))}
      {hiddenCount > 0 && (
        <Text color={theme.thinking}>... ({hiddenCount} more line{hiddenCount === 1 ? "" : "s"})</Text>
      )}
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

function displayToolName(name: string): string {
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name];
  return name.charAt(0).toUpperCase() + name.slice(1);
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

function ToolCallDisplay({ toolCall, isStreaming, verbose, terminalColumns }: { toolCall: DisplayToolCall; isStreaming?: boolean; verbose: boolean; terminalColumns: number }) {
  const [highlighted, setHighlighted] = React.useState<string | null>(null);
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
    if (lang === "text") {
      setHighlighted(raw);
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

  const bullet = "●";
  const bulletColor = toolCall.isError
    ? theme.error
    : isStreaming
      ? theme.warning
      : theme.user;
  const name = displayToolName(toolCall.name);
  const summary = summarizeToolResult(toolCall);
  const summaryColor = toolCall.isError ? theme.error : theme.muted;

  const isEditDiff = toolCall.name === "edit" && !toolCall.isError && toolCall.result;
  const isWritePreview = toolCall.name === "write" && !toolCall.isError;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color={bulletColor}>{bullet} </Text>
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
        />
      )}
      {isWritePreview && (
        <WritePreview
          content={String(toolCall.args.content || "")}
          maxLines={maxLines}
          verbose={verbose}
        />
      )}
      {!toolCall.isError && !isEditDiff && !isWritePreview && highlighted && (
        <OutputPreview text={highlighted} maxLines={maxLines} verbose={verbose} />
      )}
    </Box>
  );
}

function OutputPreview({ text, maxLines, verbose }: { text: string; maxLines: number; verbose: boolean }) {
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
      {remaining > 0 && (
        <Text color={theme.muted}>
          {verbose ? `... (${remaining} more lines)` : `… +${remaining} ${remaining === 1 ? "line" : "lines"} (ctrl+o to expand)`}
        </Text>
      )}
    </Box>
  );
}

function WritePreview({ content, maxLines, verbose }: { content: string; maxLines: number; verbose: boolean }) {
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
      {remaining > 0 && (
        <Text color={theme.muted}>
          {verbose ? `... (${remaining} more lines)` : `… +${remaining} ${remaining === 1 ? "line" : "lines"} (ctrl+o to expand)`}
        </Text>
      )}
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

function DiffBlock({ result, terminalColumns, maxLines, verbose }: { result: string; terminalColumns: number; maxLines: number; verbose: boolean }) {
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
          line.type === "add" ? "#1a3d1a" : line.type === "remove" ? "#3d1a1a" : undefined;
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
      {remaining > 0 && (
        <Text color={theme.muted}>
          {verbose ? `... (${remaining} more lines)` : `… +${remaining} ${remaining === 1 ? "line" : "lines"} (ctrl+o to expand)`}
        </Text>
      )}
    </Box>
  );
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

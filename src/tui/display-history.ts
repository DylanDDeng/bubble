import type { ToolResultMetadata, TokenUsage } from "../types.js";

export interface CompactionMeta {
  turns: number;
  messages: number;
  summarySections: Array<{ label: string; content: string }>;
  contextWindow?: number;
  compactedAt: number;
}

export type UserInputStatus = "queued" | "pending_steer";

export interface DisplayMessage {
  role: "user" | "assistant" | "error";
  content: string;
  clientId?: string;
  inputStatus?: UserInputStatus;
  reasoning?: string;
  toolCalls?: DisplayToolCall[];
  parts?: DisplayMessagePart[];
  status?: "thinking" | "responding";
  streaming?: boolean;
  syntheticKind?: "ui_compact_card";
  hiddenCount?: number;
  compactionMeta?: CompactionMeta;
  turnStartedAt?: number;
  turnCompletedAt?: number;
  turnUsage?: TokenUsage;
  taskElapsedMs?: number;
}

export type DisplayMessagePart = DisplayTextPart | DisplayToolsPart;

export interface DisplayTextPart {
  type: "text";
  content: string;
}

export interface DisplayToolsPart {
  type: "tools";
  toolCalls: DisplayToolCall[];
}

export interface DisplayToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  rawArguments?: string;
  streamingArgs?: boolean;
  /** During streaming, an approximate line count derived from `\n` escapes in rawArguments. */
  streamingNewlineCount?: number;
  status?: "pending" | "running" | "completed" | "error";
  result?: string;
  resultCollapsed?: boolean;
  isError?: boolean;
  metadata?: ToolResultMetadata;
  startedAt?: number;
  completedAt?: number;
}

export function userInputStatusBadgeLabel(status?: UserInputStatus): string | undefined {
  switch (status) {
    case "queued":
      return "QUEUED";
    case "pending_steer":
      return "STEER";
    default:
      return undefined;
  }
}

export function setUserInputStatus(message: DisplayMessage, inputStatus?: UserInputStatus): DisplayMessage {
  if (inputStatus) return { ...message, inputStatus };
  const { inputStatus: _inputStatus, ...rest } = message;
  return rest;
}

export function appendTextPart(parts: DisplayMessagePart[], content: string): void {
  if (!content) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    last.content += content;
  } else {
    parts.push({ type: "text", content });
  }
}

export function appendToolPart(parts: DisplayMessagePart[], toolCall: DisplayToolCall): void {
  const last = parts[parts.length - 1];
  if (last?.type === "tools") {
    last.toolCalls.push(toolCall);
  } else {
    parts.push({ type: "tools", toolCalls: [toolCall] });
  }
}

export function snapshotDisplayParts(parts: DisplayMessagePart[]): DisplayMessagePart[] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { ...part };
    }
    return {
      type: "tools",
      toolCalls: part.toolCalls.map(cloneToolCall),
    };
  });
}

export function contentFromParts(parts: DisplayMessagePart[]): string {
  return parts
    .filter((part): part is DisplayTextPart => part.type === "text")
    .map((part) => part.content)
    .join("");
}

export function toolCallsFromParts(parts: DisplayMessagePart[]): DisplayToolCall[] {
  return parts.flatMap((part) => part.type === "tools" ? part.toolCalls : []);
}

const MAX_VISIBLE_MESSAGES = 80;
const FULL_DETAIL_WINDOW = 24;

const COMPACTION_SUMMARY_ITEMS = 6;
const COMPACTION_FILE_LIMIT = 8;

const TOOL_PATH_KEYS = ["file", "path", "paths", "filePath"] as const;

// Display-history folding policy: message text is NEVER rewritten or truncated.
// Visible messages keep their content verbatim (older ones only collapse bulky
// tool-result bodies, which the UI can re-expand). When history exceeds
// MAX_VISIBLE_MESSAGES, the entire older span is folded behind a single summary
// card — mirroring how mainstream coding agents present compacted history —
// instead of clipping individual messages mid-sentence.
export function compactDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  let hiddenCount = 0;
  let accumulatedTurns = 0;
  const summarySections: Array<{ label: string; content: string }> = [];

  const withoutSynthetic = messages.filter((message) => {
    if (message.syntheticKind !== "ui_compact_card") {
      return true;
    }
    hiddenCount += message.hiddenCount ?? 0;
    if (message.compactionMeta) {
      accumulatedTurns += message.compactionMeta.turns;
      for (const section of message.compactionMeta.summarySections) {
        summarySections.push(section);
      }
    }
    return false;
  });

  const overflow = Math.max(0, withoutSynthetic.length - MAX_VISIBLE_MESSAGES);
  hiddenCount += overflow;
  const hiddenMessages = overflow > 0 ? withoutSynthetic.slice(0, overflow) : [];
  const visible = overflow > 0 ? withoutSynthetic.slice(overflow) : withoutSynthetic;
  const detailStart = Math.max(0, visible.length - FULL_DETAIL_WINDOW);

  const compacted = visible.map((message, index) => {
    if (message.syntheticKind === "ui_compact_card") {
      return message;
    }
    return index < detailStart ? collapseToolResults(message) : message;
  });

  if (hiddenCount === 0) {
    return compacted;
  }

  const extractedMeta = extractCompactionMeta(
    hiddenMessages,
    hiddenCount,
    accumulatedTurns,
    summarySections,
  );

  return [buildCompactCard(extractedMeta), ...compacted];
}

function extractCompactionMeta(
  hiddenMessages: DisplayMessage[],
  hiddenCount: number,
  previousTurns: number,
  previousSections: Array<{ label: string; content: string }>,
): CompactionMeta {
  const turnsInBatch = countUserTurns(hiddenMessages);
  const totalTurns = previousTurns + turnsInBatch;

  const sections: Array<{ label: string; content: string }> = [
    ...previousSections,
    ...extractSummarySections(hiddenMessages),
  ];

  return {
    turns: totalTurns,
    messages: hiddenCount,
    summarySections: mergeSummarySections(sections, COMPACTION_SUMMARY_ITEMS),
    compactedAt: Date.now(),
  };
}

function countUserTurns(messages: DisplayMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function extractSummarySections(messages: DisplayMessage[]): Array<{ label: string; content: string }> {
  const sections: Array<{ label: string; content: string }> = [];

  const userMessages = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content);

  if (userMessages.length > 0) {
    sections.push({
      label: "Progress",
      content: userMessages.slice(0, 5).map((c) => `- ${shorten(c, 100)}`).join("\n"),
    });
  }

  const assistantInsights = messages
    .filter((m) => m.role === "assistant" && m.content.trim())
    .map((m) => m.content.trim());

  if (assistantInsights.length > 0) {
    sections.push({
      label: "Decisions",
      content: assistantInsights.slice(0, 3).map((c) => `- ${shorten(c, 120)}`).join("\n"),
    });
  }

  const files = collectFiles(messages);
  if (files.length > 0) {
    sections.push({
      label: "Files",
      content: files.slice(0, COMPACTION_FILE_LIMIT).join(", "),
    });
  }

  const toolFindings = collectToolFindings(messages);
  if (toolFindings.length > 0) {
    sections.push({
      label: "Tools",
      content: toolFindings.slice(0, 5).map((f) => `- ${f}`).join("\n"),
    });
  }

  return sections;
}

function collectFiles(messages: DisplayMessage[]): string[] {
  const files = new Set<string>();

  for (const message of messages) {
    for (const tool of message.toolCalls ?? []) {
      for (const key of TOOL_PATH_KEYS) {
        const value = (tool.args as Record<string, unknown>)[key];
        if (typeof value === "string" && value) {
          files.add(value);
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string" && item) {
              files.add(item);
            }
          }
        }
      }
    }
  }

  return [...files].slice(0, COMPACTION_FILE_LIMIT);
}

function collectToolFindings(messages: DisplayMessage[]): string[] {
  const findings: string[] = [];
  for (const message of messages) {
    for (const tool of message.toolCalls ?? []) {
      if (tool.result && tool.result.length > 0) {
        findings.push(`${tool.name}: ${shorten(tool.result, 80)}`);
        if (findings.length >= 10) break;
      }
    }
    if (findings.length >= 10) break;
  }
  return findings;
}

function mergeSummarySections(
  sections: Array<{ label: string; content: string }>,
  maxItems: number,
): Array<{ label: string; content: string }> {
  const merged = new Map<string, string>();
  for (const section of sections) {
    const existing = merged.get(section.label);
    if (existing) {
      merged.set(section.label, `${existing}\n${section.content}`);
    } else {
      merged.set(section.label, section.content);
    }
  }
  return [...merged.entries()]
    .map(([label, content]) => ({ label, content }))
    .slice(0, maxItems);
}

function buildCompactCard(meta: CompactionMeta): DisplayMessage {
  const parts: string[] = [];

  if (meta.turns > 0) {
    parts.push(`${meta.turns} turn${meta.turns === 1 ? "" : "s"}`);
  }
  if (meta.messages > 0) {
    parts.push(`${meta.messages} message${meta.messages === 1 ? "" : "s"}`);
  }

  const statsLine = parts.length > 0 ? `┃ ${parts.join(" · ")}` : "";

  const sectionLines: string[] = [];
  for (const section of meta.summarySections) {
    sectionLines.push(`┃ ${section.label}: ${section.content.split("\n")[0]}`);
  }

  const content = [statsLine, ...sectionLines].filter(Boolean).join("\n");

  return {
    role: "assistant",
    content,
    syntheticKind: "ui_compact_card",
    hiddenCount: meta.messages,
    compactionMeta: meta,
    status: "responding",
  };
}

// Collapses bulky tool-result bodies on older messages while leaving the
// message text (content, reasoning) verbatim — never truncate what the user
// or the assistant actually said.
function collapseToolResults(message: DisplayMessage): DisplayMessage {
  if (message.syntheticKind === "ui_compact_card") {
    return message;
  }

  return {
    ...message,
    toolCalls: message.toolCalls?.map(compactToolCall),
    parts: message.parts?.map(compactDisplayPart),
  };
}

function cloneToolCall(toolCall: DisplayToolCall): DisplayToolCall {
  return {
    ...toolCall,
    args: { ...toolCall.args },
  };
}

function compactDisplayPart(part: DisplayMessagePart): DisplayMessagePart {
  if (part.type === "text") {
    return part;
  }
  return {
    type: "tools",
    toolCalls: part.toolCalls.map(compactToolCall),
  };
}

function compactToolCall(toolCall: DisplayToolCall): DisplayToolCall {
  if (toolCall.result === undefined) {
    return toolCall;
  }

  return {
    ...toolCall,
    result: undefined,
    resultCollapsed: true,
  };
}

function shorten(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

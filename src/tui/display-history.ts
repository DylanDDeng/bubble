export interface CompactionMeta {
  turns: number;
  messages: number;
  tokensSaved: number;
  summarySections: Array<{ label: string; content: string }>;
  contextWindow?: number;
  compactedAt: number;
}

export interface DisplayMessage {
  role: "user" | "assistant" | "error";
  content: string;
  reasoning?: string;
  toolCalls?: DisplayToolCall[];
  status?: "thinking" | "responding";
  streaming?: boolean;
  syntheticKind?: "ui_compact_card";
  hiddenCount?: number;
  compactionMeta?: CompactionMeta;
}

export interface DisplayToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  status?: "pending" | "running" | "completed" | "error";
  result?: string;
  isError?: boolean;
}

const MAX_VISIBLE_MESSAGES = 80;
const FULL_DETAIL_WINDOW = 24;
const MAX_OLD_CONTENT_CHARS = 1200;
const MAX_OLD_REASONING_CHARS = 600;
const MAX_OLD_TOOL_RESULT_CHARS = 800;

const COMPACTION_SUMMARY_ITEMS = 6;
const COMPACTION_FILE_LIMIT = 8;

const TOOL_PATH_KEYS = ["file", "path", "paths", "filePath"] as const;

export function compactDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  let hiddenCount = 0;
  let accumulatedTurns = 0;
  let accumulatedTokens = 0;
  const summarySections: Array<{ label: string; content: string }> = [];

  const withoutSynthetic = messages.filter((message) => {
    if (message.syntheticKind !== "ui_compact_card") {
      return true;
    }
    hiddenCount += message.hiddenCount ?? 0;
    if (message.compactionMeta) {
      accumulatedTurns += message.compactionMeta.turns;
      accumulatedTokens += message.compactionMeta.tokensSaved;
      for (const section of message.compactionMeta.summarySections) {
        summarySections.push(section);
      }
    }
    return false;
  });

  const overflow = Math.max(0, withoutSynthetic.length - MAX_VISIBLE_MESSAGES);
  hiddenCount += overflow;
  const visible = overflow > 0 ? withoutSynthetic.slice(overflow) : withoutSynthetic;
  const detailStart = Math.max(0, visible.length - FULL_DETAIL_WINDOW);

  const compacted = visible.map((message, index) => {
    if (message.syntheticKind === "ui_compact_card") {
      return message;
    }
    return index < detailStart ? compactDisplayMessage(message) : message;
  });

  if (hiddenCount === 0) {
    return compacted;
  }

  const truncatedMessages = visible.slice(0, Math.max(1, detailStart));
  const extractedMeta = extractCompactionMeta(
    truncatedMessages,
    hiddenCount,
    accumulatedTurns,
    accumulatedTokens,
    summarySections,
  );

  return [buildCompactCard(extractedMeta), ...compacted];
}

function extractCompactionMeta(
  truncatedMessages: DisplayMessage[],
  hiddenCount: number,
  previousTurns: number,
  previousTokens: number,
  previousSections: Array<{ label: string; content: string }>,
): CompactionMeta {
  const turnsInBatch = countUserTurns(truncatedMessages);
  const totalTurns = previousTurns + turnsInBatch;

  const messagesInBatch = truncatedMessages.length;
  const totalMessages = hiddenCount;

  const estimatedTokens = estimateTokenSavings(truncatedMessages);
  const totalTokens = previousTokens + estimatedTokens;

  const sections: Array<{ label: string; content: string }> = [
    ...previousSections,
    ...extractSummarySections(truncatedMessages),
  ];

  return {
    turns: totalTurns,
    messages: totalMessages,
    tokensSaved: totalTokens > 0 ? totalTokens : estimatedTokens,
    summarySections: mergeSummarySections(sections, COMPACTION_SUMMARY_ITEMS),
    compactedAt: Date.now(),
  };
}

function countUserTurns(messages: DisplayMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function estimateTokenSavings(messages: DisplayMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
    chars += (message.reasoning?.length ?? 0);
    for (const tool of message.toolCalls ?? []) {
      chars += (tool.result?.length ?? 0);
      chars += JSON.stringify(tool.args).length;
    }
  }
  return Math.ceil(chars / 4);
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
  const formatNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const parts: string[] = [];

  if (meta.turns > 0) {
    parts.push(`${meta.turns} turn${meta.turns === 1 ? "" : "s"}`);
  }
  if (meta.messages > 0) {
    parts.push(`${meta.messages} message${meta.messages === 1 ? "" : "s"}`);
  }
  if (meta.tokensSaved > 0) {
    parts.push(`~${formatNum(meta.tokensSaved)} tokens`);
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

function compactDisplayMessage(message: DisplayMessage): DisplayMessage {
  if (message.syntheticKind === "ui_compact_card") {
    return message;
  }

  return {
    ...message,
    content: truncateText(message.content, MAX_OLD_CONTENT_CHARS),
    reasoning: message.reasoning
      ? truncateText(message.reasoning, MAX_OLD_REASONING_CHARS)
      : message.reasoning,
    toolCalls: message.toolCalls?.map((toolCall) => ({
      ...toolCall,
      result: toolCall.result
        ? truncateText(toolCall.result, MAX_OLD_TOOL_RESULT_CHARS)
        : toolCall.result,
    })),
  };
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const head = Math.max(1, Math.floor(maxChars * 0.7));
  const tail = Math.max(1, maxChars - head - 32);
  const omitted = value.length - head - tail;
  const separator = "─".repeat(12);
  return `${value.slice(0, head)}\n${separator} ✂ ${omitted} chars truncated ${separator}\n${value.slice(-tail)}`;
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

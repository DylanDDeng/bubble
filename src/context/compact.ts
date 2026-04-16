import type { ContentPart, Message, ToolCall } from "../types.js";
import type { SessionLogEntry } from "../session-types.js";

export interface CompactOptions {
  keepRecentTurns?: number;
  maxSummaryItems?: number;
}

export interface CompactResult {
  compacted: boolean;
  summary?: string;
  entries?: SessionLogEntry[];
  messages?: Message[];
  droppedEntries?: number;
}

export function compactSessionEntries(
  entries: SessionLogEntry[],
  options: CompactOptions = {},
): CompactResult {
  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const maxSummaryItems = options.maxSummaryItems ?? 4;

  const metadataEntries = entries.filter((entry) => entry.type === "metadata");
  const nonMetadataEntries = entries.filter((entry) => entry.type !== "metadata");
  const latestSummaryIndex = findLatestSummaryIndex(nonMetadataEntries);
  const baseIndex = latestSummaryIndex >= 0 ? latestSummaryIndex + 1 : 0;
  const activeEntries = nonMetadataEntries.slice(baseIndex);
  const turnStartIndexes = activeEntries
    .map((entry, index) => (entry.type === "user_message" ? index : -1))
    .filter((index) => index >= 0);

  if (turnStartIndexes.length <= keepRecentTurns) {
    return { compacted: false };
  }

  const keepStartIndex = turnStartIndexes[Math.max(0, turnStartIndexes.length - keepRecentTurns)];
  if (keepStartIndex <= 0) {
    return { compacted: false };
  }

  const oldEntries = activeEntries.slice(0, keepStartIndex);
  const keptEntries = activeEntries.slice(keepStartIndex);
  const summary = buildCompactionSummary(oldEntries, maxSummaryItems);
  if (!summary) {
    return { compacted: false };
  }

  const summaryEntry: SessionLogEntry = {
    id: nextSummaryId(entries),
    type: "summary",
    summary,
    timestamp: Date.now(),
  };

  const nextEntries = [
    ...metadataEntries,
    summaryEntry,
    ...keptEntries,
  ];

  return {
    compacted: true,
    summary,
    entries: nextEntries,
    droppedEntries: oldEntries.length,
  };
}

export function compactMessages(
  messages: Message[],
  options: CompactOptions = {},
): CompactResult {
  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const maxSummaryItems = options.maxSummaryItems ?? 4;
  const systemMessages = messages.filter((message) => message.role === "system");
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const turnStartIndexes = nonSystemMessages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);

  if (turnStartIndexes.length <= keepRecentTurns) {
    return { compacted: false };
  }

  const keepStartIndex = turnStartIndexes[Math.max(0, turnStartIndexes.length - keepRecentTurns)];
  if (keepStartIndex <= 0) {
    return { compacted: false };
  }

  const oldMessages = nonSystemMessages.slice(0, keepStartIndex);
  const keptMessages = nonSystemMessages.slice(keepStartIndex);
  const summary = buildMessageSummary(oldMessages, maxSummaryItems);
  if (!summary) {
    return { compacted: false };
  }

  const compactedMessages: Message[] = [
    ...systemMessages.map((message) => cloneMessage(message)),
    {
      role: "system",
      content: `Previous conversation summary:\n${summary}`,
    },
    ...keptMessages.map((message) => cloneMessage(message)),
  ];

  return {
    compacted: true,
    summary,
    messages: compactedMessages,
    droppedEntries: oldMessages.length,
  };
}

function buildCompactionSummary(entries: SessionLogEntry[], maxSummaryItems: number): string {
  const messages = entriesToMessages(entries);
  return buildMessageSummary(messages, maxSummaryItems);
}

function buildMessageSummary(messages: Message[], maxSummaryItems: number): string {
  if (messages.length === 0) {
    return "";
  }

  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolCalls = collectToolCalls(messages);
  const relevantFiles = collectRelevantFiles(toolCalls);
  const toolFindings = collectToolFindings(messages, maxSummaryItems);

  const goal = userMessages[0] ? summarizeContent(userMessages[0].content) : "Unknown";
  const progress = userMessages.slice(0, maxSummaryItems).map((message) => `- ${summarizeContent(message.content)}`);
  const decisions = assistantMessages
    .map((message) => message.content.trim())
    .filter(Boolean)
    .slice(0, maxSummaryItems)
    .map((content) => `- ${summarizeText(content)}`);

  const lines = [
    "Goal:",
    `- ${goal}`,
    "",
    "Progress:",
    ...(progress.length > 0 ? progress : ["- No user progress recorded"]),
    "",
    "Key Decisions:",
    ...(decisions.length > 0 ? decisions : ["- No assistant decisions recorded"]),
    "",
    "Next Steps:",
    ["- Continue from the most recent preserved turn"],
    "",
    "Relevant Files:",
    ...(relevantFiles.length > 0 ? relevantFiles.map((file) => `- ${file}`) : ["- None captured"]),
    "",
    "Tool Findings:",
    ...(toolFindings.length > 0 ? toolFindings.map((item) => `- ${item}`) : ["- None captured"]),
  ];

  return lines.flat().join("\n");
}

function entriesToMessages(entries: SessionLogEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "user_message":
        messages.push({ ...entry.message });
        break;
      case "assistant_message":
        messages.push({
          role: "assistant",
          content: entry.message.content,
          reasoning: entry.message.reasoning,
        });
        break;
      case "tool_call": {
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
          last.toolCalls = [...(last.toolCalls ?? []), { ...entry.toolCall }];
        } else {
          messages.push({
            role: "assistant",
            content: "",
            toolCalls: [{ ...entry.toolCall }],
          });
        }
        break;
      }
      case "tool_result":
        messages.push({ ...entry.message });
        break;
      default:
        break;
    }
  }

  return messages;
}

function collectToolCalls(messages: Message[]): ToolCall[] {
  return messages.flatMap((message) => message.role === "assistant" ? (message.toolCalls ?? []) : []);
}

function collectRelevantFiles(toolCalls: ToolCall[]): string[] {
  const files = new Set<string>();

  for (const toolCall of toolCalls) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(toolCall.arguments || "{}") as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    for (const key of ["file", "path", "paths"]) {
      const value = parsed[key];
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

  return [...files].slice(0, 12);
}

function collectToolFindings(messages: Message[], maxItems: number): string[] {
  const findings: string[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        toolNameByCallId.set(toolCall.id, toolCall.name);
      }
      continue;
    }

    if (message.role !== "tool") {
      continue;
    }

    const toolName = toolNameByCallId.get(message.toolCallId) ?? "tool";
    findings.push(`${toolName}: ${summarizeText(message.content)}`);
    if (findings.length >= maxItems) {
      break;
    }
  }

  return findings;
}

function summarizeContent(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return summarizeText(content);
  }

  const textParts = content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text);
  return summarizeText(textParts.join(" "));
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized || "(empty)";
  }
  return `${normalized.slice(0, 137)}...`;
}

function findLatestSummaryIndex(entries: SessionLogEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].type === "summary") {
      return index;
    }
  }
  return -1;
}

function nextSummaryId(entries: SessionLogEntry[]): string {
  return `${entries.length + 1}`;
}

function cloneMessage(message: Message): Message {
  if (message.role === "assistant") {
    return {
      ...message,
      toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    };
  }

  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((part) => ({
        ...part,
        ...(part.type === "image_url" ? { image_url: { ...part.image_url } } : {}),
      })),
    };
  }

  return { ...message };
}

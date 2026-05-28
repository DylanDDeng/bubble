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
  const preservedContextMessages = messages.filter((message) => message.role === "system" || message.role === "meta");
  const conversationalMessages = messages.filter((message) => message.role !== "system" && message.role !== "meta");
  const turnStartIndexes = conversationalMessages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);

  if (turnStartIndexes.length <= keepRecentTurns) {
    return { compacted: false };
  }

  const keepStartIndex = turnStartIndexes[Math.max(0, turnStartIndexes.length - keepRecentTurns)];
  if (keepStartIndex <= 0) {
    return { compacted: false };
  }

  const oldMessages = conversationalMessages.slice(0, keepStartIndex);
  const keptMessages = conversationalMessages.slice(keepStartIndex);
  const summary = buildMessageSummary(oldMessages, maxSummaryItems);
  if (!summary) {
    return { compacted: false };
  }

  const compactedMessages: Message[] = [
    ...preservedContextMessages.map((message) => cloneMessage(message)),
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

/**
 * Sub-turn compaction.
 *
 * When the active user turn has accumulated many (assistant + tool-result) groups
 * — typically a single "look at this project" prompt that triggers a dozen file
 * reads — multi-turn compactMessages above is a no-op (there's only one user turn
 * to summarize). This variant operates one level finer: it groups messages inside
 * the last user turn by assistant message, keeps the most recent K groups intact,
 * and replaces the older ones with a synthetic system message that names the tools
 * called and files inspected.
 *
 * Constraints honored:
 * - Older groups are dropped WHOLE (assistant + its tool results). Dropping just
 *   the tool results would leave orphan tool_calls; repairToolCallChains would
 *   then synthesize "[no result captured]" placeholders, undoing the win.
 * - Pre-turn content (earlier user turns) is left untouched — that's the
 *   multi-turn compactor's territory.
 */
export interface SubTurnCompactOptions {
  keepRecentGroups?: number;
  maxSummaryItems?: number;
}

export function compactCurrentTurnToolGroups(
  messages: Message[],
  options: SubTurnCompactOptions = {},
): CompactResult {
  const keepRecentGroups = options.keepRecentGroups ?? 2;
  const maxSummaryItems = options.maxSummaryItems ?? 8;

  const preserved = messages.filter((m) => m.role === "system" || m.role === "meta");
  const body = messages.filter((m) => m.role !== "system" && m.role !== "meta");

  let lastUserIndex = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return { compacted: false };

  const preTurn = body.slice(0, lastUserIndex + 1);
  const turnBody = body.slice(lastUserIndex + 1);

  type Group = { assistant: Message; toolResults: Message[] };
  const groups: Group[] = [];
  let current: Group | null = null;

  for (const msg of turnBody) {
    if (msg.role === "assistant") {
      if (current) groups.push(current);
      current = { assistant: msg, toolResults: [] };
    } else if (msg.role === "tool" && current) {
      current.toolResults.push(msg);
    }
  }
  if (current) groups.push(current);

  if (groups.length <= keepRecentGroups) return { compacted: false };

  // Only drop groups that have tool_calls — text-only assistant messages don't
  // free much context, and dropping them confuses the conversation flow.
  const evictable = groups.slice(0, groups.length - keepRecentGroups)
    .filter((g) => g.assistant.role === "assistant" && (g.assistant.toolCalls?.length ?? 0) > 0);
  if (evictable.length === 0) return { compacted: false };

  const summary = buildToolGroupsSummary(evictable, maxSummaryItems);
  if (!summary) return { compacted: false };

  const survivingGroups = groups.filter((g) => !evictable.includes(g));
  const flatSurvivors: Message[] = [];
  for (const g of survivingGroups) {
    flatSurvivors.push(cloneMessage(g.assistant));
    for (const t of g.toolResults) flatSurvivors.push(cloneMessage(t));
  }

  const compactedMessages: Message[] = [
    ...preserved.map(cloneMessage),
    ...preTurn.map(cloneMessage),
    {
      role: "system",
      content: `Earlier in this turn (compacted to free context):\n${summary}`,
    },
    ...flatSurvivors,
  ];

  return {
    compacted: true,
    summary,
    messages: compactedMessages,
    droppedEntries: evictable.length,
  };
}

function buildToolGroupsSummary(
  groups: Array<{ assistant: Message; toolResults: Message[] }>,
  maxItems: number,
): string {
  const toolCounts = new Map<string, number>();
  const fileSet = new Set<string>();
  let totalResultChars = 0;
  const findings: string[] = [];

  for (const group of groups) {
    if (group.assistant.role !== "assistant" || !group.assistant.toolCalls) continue;
    const toolNameByCallId = new Map<string, string>();
    for (const tc of group.assistant.toolCalls) {
      toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
      toolNameByCallId.set(tc.id, tc.name);
      try {
        const parsed = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
        for (const key of ["file_path", "path", "paths", "file"]) {
          const v = parsed[key];
          if (typeof v === "string" && v) fileSet.add(v);
          else if (Array.isArray(v)) {
            for (const item of v) if (typeof item === "string" && item) fileSet.add(item);
          }
        }
      } catch {
        // ignore unparseable args
      }
    }
    for (const r of group.toolResults) {
      if (r.role !== "tool") continue;
      const content = typeof r.content === "string" ? r.content : "";
      totalResultChars += content.length;
      if (findings.length < maxItems) {
        const toolName = toolNameByCallId.get(r.toolCallId) ?? "tool";
        findings.push(`${toolName}: ${summarizeText(content)}`);
      }
    }
  }

  const lines: string[] = [];
  const toolList = [...toolCounts.entries()]
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(", ");
  lines.push(`Tools used: ${toolList || "none"}`);
  if (fileSet.size > 0) {
    const fileList = [...fileSet].slice(0, 12);
    lines.push(
      `Files touched: ${fileList.join(", ")}${fileSet.size > 12 ? ` (+${fileSet.size - 12} more)` : ""}`,
    );
  }
  lines.push(
    `Discarded ~${formatChars(totalResultChars)} of earlier tool output. Re-run the relevant tool if you need specifics.`,
  );
  if (findings.length > 0) {
    lines.push("");
    lines.push("Earlier findings:");
    for (const f of findings) lines.push(`- ${f}`);
  }

  return lines.join("\n");
}

function formatChars(count: number): string {
  if (count < 1000) return `${count} chars`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K chars`;
  return `${(count / 1_000_000).toFixed(2)}M chars`;
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
          ...entry.message,
          role: "assistant",
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

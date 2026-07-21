import type { ContentPart, Message, ToolCall } from "../types.js";
import type { SessionLogEntry } from "../session-types.js";
import { isInternalBlockContent } from "../agent/internal-reminder-sanitizer.js";

/**
 * Compaction must never summarize away what the user actually asked for:
 * requirements that appear late in a long instruction ("commit when done",
 * "write the report in French") would otherwise vanish once the heuristic
 * summary truncates the goal line. Messages larger than this cap are pinned
 * in truncated form (e.g. a pasted megabyte of logs as the opening message).
 */
export const PINNED_INSTRUCTION_MAX_CHARS = 8192;

export const COMPACTION_SUMMARY_PREFIX = "Previous conversation summary:";
export const SUBTURN_SUMMARY_PREFIX = "Earlier in this turn (compacted to free context):";
// llm-compactor.ts's LLM_SUMMARY_PREFIX must start with this literal — a unit
// test locks the two together (importing it here would create a module cycle).
const LLM_ENVELOPE_PREFIX = "Another language model previously worked on this task";
// Projected forms: the projector wraps meta messages into user-role internal
// blocks, and the resident-history path writes that projected form back, so a
// summary emitted as meta can come back around as one of these.
const PROJECTED_SUMMARY_PREFIXES = [
  `<bubble_internal_context kind="compaction-summary">`,
  `<bubble_internal_context kind="subturn-compaction-summary">`,
  // Legacy: summaries emitted as raw system messages by ≤0.0.42 got projected
  // into runtime-system blocks.
  `<bubble_internal_context kind="runtime-system">\n${COMPACTION_SUMMARY_PREFIX}`,
  `<bubble_internal_context kind="runtime-system">\n${SUBTURN_SUMMARY_PREFIX}`,
];

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join(" ");
  }
  return "";
}

/**
 * Identity check for compaction summaries across every form they can take:
 * the first-class meta form, the legacy raw-system form, and the projected
 * user-role internal-block forms (the resident path rewrites projections back
 * into history, so role/position are not conserved).
 */
export function isCompactionSummaryMessage(message: Message): boolean {
  if (message.role === "meta") {
    return message.kind === "compaction-summary" || message.kind === "subturn-compaction-summary";
  }
  const text = messageText(message);
  if (message.role === "system") {
    return text.startsWith(COMPACTION_SUMMARY_PREFIX) || text.startsWith(SUBTURN_SUMMARY_PREFIX);
  }
  if (message.role === "user") {
    const trimmed = text.trimStart();
    if (trimmed.startsWith(LLM_ENVELOPE_PREFIX)) return true;
    return PROJECTED_SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  }
  return false;
}

/** A message the user actually typed (not a projected reminder, not a summary). */
export function isRealUserMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  const text = messageText(message);
  if (!text.trim() || isInternalBlockContent(text)) return false;
  if (text.trimStart().startsWith(LLM_ENVELOPE_PREFIX)) return false;
  return true;
}

/**
 * Split history into the leading system/meta context prefix (system prompt,
 * startup reminders) and the conversational body. Positional, mirroring the
 * projector's leading-prefix semantics: mid-history system/meta messages
 * belong to the body and are foldable — preserving them by role forever is
 * how stale reminders and relocated summaries used to pile up at the head.
 */
export function splitLeadingContext(messages: Message[]): { leading: Message[]; body: Message[] } {
  let split = 0;
  while (split < messages.length) {
    const message = messages[split];
    if ((message.role === "system" || message.role === "meta") && !isCompactionSummaryMessage(message)) {
      split += 1;
      continue;
    }
    break;
  }
  return { leading: messages.slice(0, split), body: messages.slice(split) };
}

/** Index of the first message the user actually wrote. */
export function findFirstRealUserIndex(messages: Message[]): number {
  for (let index = 0; index < messages.length; index++) {
    if (isRealUserMessage(messages[index])) return index;
  }
  return -1;
}

/**
 * Clone a message for pinning; oversized content is truncated rather than
 * losing the pin entirely (P0.5: a truncated original beats a 140-char
 * summary line).
 */
export function clonePinnedUserMessage(message: Message): Message {
  const text = messageText(message);
  if (text.length <= PINNED_INSTRUCTION_MAX_CHARS) return cloneMessage(message);
  return {
    role: "user",
    content: `${text.slice(0, PINNED_INSTRUCTION_MAX_CHARS)}\n[...original message truncated for context management...]`,
  };
}

export function buildCompactionSummaryMessage(summary: string): Message {
  return {
    role: "meta",
    kind: "compaction-summary",
    content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}`,
  };
}

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

/**
 * The split of a session log into (metadata, old-to-summarize, kept-verbatim)
 * when it is large enough to compact. `compactable: false` means there aren't
 * enough turns past the last summary to bother.
 *
 * Extracted so callers that supply their OWN summary (e.g. the LLM-backed
 * manual `/compact`) can reuse the exact same turn-boundary logic instead of
 * forking it. `compactSessionEntries` is just this plan + a heuristic summary.
 */
export type SessionCompactionPlan =
  | { compactable: false }
  | {
      compactable: true;
      metadataEntries: SessionLogEntry[];
      oldEntries: SessionLogEntry[];
      keptEntries: SessionLogEntry[];
    };

export function planSessionCompaction(
  entries: SessionLogEntry[],
  options: CompactOptions = {},
): SessionCompactionPlan {
  const keepRecentTurns = options.keepRecentTurns ?? 2;

  const metadataEntries = entries.filter((entry) => entry.type === "metadata");
  const nonMetadataEntries = entries.filter((entry) => entry.type !== "metadata");
  const latestSummaryIndex = findLatestSummaryIndex(nonMetadataEntries);
  const baseIndex = latestSummaryIndex >= 0 ? latestSummaryIndex + 1 : 0;
  const activeEntries = nonMetadataEntries.slice(baseIndex);
  const turnStartIndexes = activeEntries
    .map((entry, index) => (entry.type === "user_message" ? index : -1))
    .filter((index) => index >= 0);

  if (turnStartIndexes.length <= keepRecentTurns) {
    return { compactable: false };
  }

  const keepStartIndex = turnStartIndexes[Math.max(0, turnStartIndexes.length - keepRecentTurns)];
  if (keepStartIndex <= 0) {
    return { compactable: false };
  }

  return {
    compactable: true,
    metadataEntries,
    oldEntries: activeEntries.slice(0, keepStartIndex),
    keptEntries: activeEntries.slice(keepStartIndex),
  };
}

/**
 * Assemble the post-compaction entry list from a plan and a (possibly
 * LLM-generated) summary string. The summary entry is keyed off the full
 * original `entries` so its id never collides with a prior summary.
 */
export function buildCompactedEntries(
  entries: SessionLogEntry[],
  plan: Extract<SessionCompactionPlan, { compactable: true }>,
  summary: string,
): SessionLogEntry[] {
  const summaryEntry: SessionLogEntry = {
    id: nextSummaryId(entries),
    type: "summary",
    summary,
    timestamp: Date.now(),
  };
  return [...plan.metadataEntries, summaryEntry, ...plan.keptEntries];
}

/** Flatten a plan's old entries into messages for an external summarizer. */
export function planOldMessages(
  plan: Extract<SessionCompactionPlan, { compactable: true }>,
): Message[] {
  return entriesToMessages(plan.oldEntries);
}

export function compactSessionEntries(
  entries: SessionLogEntry[],
  options: CompactOptions = {},
): CompactResult {
  const maxSummaryItems = options.maxSummaryItems ?? 4;
  const plan = planSessionCompaction(entries, options);
  if (!plan.compactable) {
    return { compacted: false };
  }

  const summary = buildCompactionSummary(plan.oldEntries, maxSummaryItems);
  if (!summary) {
    return { compacted: false };
  }

  return {
    compacted: true,
    summary,
    entries: buildCompactedEntries(entries, plan, summary),
    droppedEntries: plan.oldEntries.length,
  };
}

export function compactMessages(
  messages: Message[],
  options: CompactOptions = {},
): CompactResult {
  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const maxSummaryItems = options.maxSummaryItems ?? 4;

  // Replace semantics: prior summaries (any form, any position) die here —
  // at most one summary exists after every compaction. Their content is
  // template-grade (goal truncated to 140 chars, constant next-steps line);
  // the pinned original instruction is the durable record, not old summaries.
  const { leading, body } = splitLeadingContext(messages);
  const bodyMessages = body.filter((message) => !isCompactionSummaryMessage(message));

  // Turn boundaries anchor on REAL user messages only. Projected reminders
  // and summary envelopes used to inflate the turn count, shrinking the keep
  // window to nothing and firing compaction almost every turn.
  const turnStartIndexes = bodyMessages
    .map((message, index) => (isRealUserMessage(message) ? index : -1))
    .filter((index) => index >= 0);

  if (turnStartIndexes.length <= keepRecentTurns) {
    return { compacted: false };
  }

  const keepStartIndex = turnStartIndexes[Math.max(0, turnStartIndexes.length - keepRecentTurns)];
  if (keepStartIndex <= 0) {
    return { compacted: false };
  }

  const oldMessages = bodyMessages.slice(0, keepStartIndex);
  const keptMessages = bodyMessages.slice(keepStartIndex);

  // Pin the original instruction: it stays verbatim above the summary instead
  // of being crushed into the summary's 140-char goal line.
  const pinnedIndex = findFirstRealUserIndex(oldMessages);
  const pinnedMessage = pinnedIndex >= 0 ? oldMessages[pinnedIndex] : undefined;
  // Summary fodder: real conversational content only — no pinned original,
  // no projected reminder blocks (they used to pollute Goal/Progress lines).
  const summaryInput = oldMessages.filter((message, index) =>
    index !== pinnedIndex
    && message.role !== "meta"
    && !(message.role === "user" && !isRealUserMessage(message)));

  const summary = buildMessageSummary(summaryInput, maxSummaryItems);
  if (!summary) {
    return { compacted: false };
  }

  const compactedMessages: Message[] = [
    ...leading.map((message) => cloneMessage(message)),
    ...(pinnedMessage ? [clonePinnedUserMessage(pinnedMessage)] : []),
    buildCompactionSummaryMessage(summary),
    ...keptMessages.map((message) => cloneMessage(message)),
  ];

  return {
    compacted: true,
    summary,
    messages: compactedMessages,
    droppedEntries: summaryInput.length,
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

  const { leading, body } = splitLeadingContext(messages);

  // Anchor the "current turn" on the last REAL user message — a projected
  // reminder must not shrink the turn to a sliver.
  let lastUserIndex = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (isRealUserMessage(body[i])) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return { compacted: false };

  const preTurn = body.slice(0, lastUserIndex + 1);
  const rawTurnBody = body.slice(lastUserIndex + 1);
  // Replace semantics within the turn: fold prior sub-turn summaries' lines
  // into the new one instead of stacking marker messages.
  const priorSubturnSummaries = rawTurnBody.filter((m) =>
    m.role === "meta" ? m.kind === "subturn-compaction-summary" : isCompactionSummaryMessage(m) && messageText(m).includes(SUBTURN_SUMMARY_PREFIX.slice(0, 20)));
  const turnBody = rawTurnBody.filter((m) => !priorSubturnSummaries.includes(m));

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

  const freshSummary = buildToolGroupsSummary(evictable, maxSummaryItems);
  if (!freshSummary) return { compacted: false };
  const summary = mergeSubturnSummaryLines(priorSubturnSummaries, freshSummary, maxSummaryItems);

  const survivingGroups = groups.filter((g) => !evictable.includes(g));
  const flatSurvivors: Message[] = [];
  for (const g of survivingGroups) {
    flatSurvivors.push(cloneMessage(g.assistant));
    for (const t of g.toolResults) flatSurvivors.push(cloneMessage(t));
  }

  const compactedMessages: Message[] = [
    ...leading.map(cloneMessage),
    ...preTurn.map(cloneMessage),
    {
      role: "meta",
      kind: "subturn-compaction-summary",
      content: `${SUBTURN_SUMMARY_PREFIX}\n${summary}`,
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

/**
 * Merge prior sub-turn summary lines with the fresh one: line-level dedupe,
 * prior lines first (chronological), capped. Structured merge of tool-name /
 * file lists — not freetext concatenation.
 */
function mergeSubturnSummaryLines(
  priorSummaries: Message[],
  freshSummary: string,
  maxItems: number,
): string {
  if (priorSummaries.length === 0) return freshSummary;
  const seen = new Set<string>();
  const merged: string[] = [];
  const push = (line: string) => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(line);
  };
  for (const prior of priorSummaries) {
    for (const line of messageText(prior).split("\n")) {
      if (line.startsWith(SUBTURN_SUMMARY_PREFIX) || line.startsWith("<bubble_internal_")) continue;
      push(line);
    }
  }
  for (const line of freshSummary.split("\n")) push(line);
  const cap = Math.max(maxItems * 4, 24);
  return merged.slice(-cap).join("\n");
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
  let max = 0;
  for (const entry of entries) {
    const match = /^(\d+)/.exec(entry.id);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `${max + 1}`;
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

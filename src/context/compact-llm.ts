/**
 * LLM-backed structured conversation compaction.
 *
 * Generates a 9-section summary of the older turns via the provider's
 * completion API, replacing the dropped history with a single system
 * message. Falls back to the heuristic `compactMessages` if the LLM call
 * fails.
 */

import {
  buildCompactionSummaryMessage,
  clonePinnedUserMessage,
  collectCompactionFileOps,
  compactMessages as compactMessagesHeuristic,
  findFirstRealUserIndex,
  isCompactionSummaryMessage,
  isRealUserMessage,
  messageText,
  splitLeadingContext,
} from "./compact.js";
import { sanitizeInternalReminderBlocks } from "../agent/internal-reminder-sanitizer.js";
import { appendFileBlocks, stripFileBlocks } from "./compaction-files.js";
import type { CompactOptions, CompactResult } from "./compact.js";
import type { Message, Provider, ProviderMessage, ThinkingLevel, ToolCall } from "../types.js";

export interface LLMCompactOptions extends CompactOptions {
  provider: Provider;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to produce a structured
summary of an earlier portion of a software-engineering assistant's
conversation so that the assistant can continue working without the full
history. Preserve fidelity over brevity where the user's intent, file
paths, or decisions are concerned. Output ONLY the summary, no preamble.`;

export const COMPACT_INSTRUCTIONS = `Summarize the conversation above using exactly these 9 sections, each
preceded by the literal heading on its own line. If a section has no
content, write "None".

1. Primary Request and Intent
   - What the user ultimately wants, in their own framing.

2. Key Technical Concepts
   - Libraries, frameworks, architectural patterns referenced.

3. Files and Code Sections
   - Files read, written, or discussed. Include full paths and a one-line note.

4. Errors and Fixes
   - Bugs encountered and how they were resolved.

5. Problem Solving
   - Non-trivial debugging or design decisions.

6. All User Messages
   - Every user message, verbatim, in order. Do not summarize here.

7. Pending Tasks
   - Work that was planned but not yet completed.

8. Current Work
   - What was being actively worked on when the summary was taken.

9. Optional Next Step
   - The single most natural next action, if obvious.`;

export async function compactMessagesWithLLM(
  messages: Message[],
  options: LLMCompactOptions,
): Promise<CompactResult> {
  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const { leading, body } = splitLeadingContext(messages);
  // Replace semantics: prior summaries (any form) are folded into the new
  // summary as INPUT (the LLM merges them semantically) and removed.
  const priorSummaries = body.filter(isCompactionSummaryMessage);
  const bodyMessages = body.filter((m) => !isCompactionSummaryMessage(m));
  const turnStartIndexes = bodyMessages
    .map((m, i) => (isRealUserMessage(m) ? i : -1))
    .filter((i) => i >= 0);

  if (turnStartIndexes.length <= keepRecentTurns) {
    return { compacted: false };
  }

  const keepStartIndex = turnStartIndexes[Math.max(0, turnStartIndexes.length - keepRecentTurns)];
  if (keepStartIndex <= 0) {
    return { compacted: false };
  }

  const oldMessages = bodyMessages.slice(0, keepStartIndex);
  const keptMessages = bodyMessages.slice(keepStartIndex);

  // Pin the original instruction verbatim (P0.5: this path used to lack the
  // pin the heuristic and llm-compactor paths already had).
  const pinnedIndex = findFirstRealUserIndex(oldMessages);
  const pinnedMessage = pinnedIndex >= 0 ? oldMessages[pinnedIndex] : undefined;

  // File blocks are stripped from prior summaries before summarization: the
  // deterministic merge below owns the file lists end to end.
  const summarizable: Message[] = [
    ...priorSummaries.map((m): Message => ({
      role: "user",
      content: `[Prior compaction summary]\n${stripFileBlocks(messageText(m))}`,
    })),
    ...oldMessages.filter((_, index) => index !== pinnedIndex),
  ];

  const fileOps = collectCompactionFileOps(oldMessages, priorSummaries);

  let summary: string;
  try {
    summary = await generateSummary(summarizable, options);
  } catch {
    return compactMessagesHeuristic(messages, { keepRecentTurns, maxSummaryItems: options.maxSummaryItems });
  }

  // Models quote their input, and the transcript can contain projected
  // reminder blocks; this summary is persisted, so scrub markup first.
  summary = sanitizeInternalReminderBlocks(summary).trim();
  if (!summary) {
    return compactMessagesHeuristic(messages, { keepRecentTurns, maxSummaryItems: options.maxSummaryItems });
  }

  const summaryWithFiles = appendFileBlocks(summary, fileOps);
  return {
    compacted: true,
    summary: summaryWithFiles,
    messages: [
      ...leading,
      ...(pinnedMessage ? [clonePinnedUserMessage(pinnedMessage)] : []),
      buildCompactionSummaryMessage(summaryWithFiles),
      ...keptMessages,
    ],
    droppedEntries: oldMessages.length,
  };
}

/**
 * Build the two-message prompt that asks the model for a 9-section summary of
 * `oldMessages`. Shared by the non-streaming overflow path (`generateSummary`)
 * and the streaming manual `/compact` path (`Agent.summarizeForCompaction`).
 */
export function buildCompactionPromptMessages(oldMessages: Message[]): ProviderMessage[] {
  const transcript = serializeTranscript(oldMessages);
  return [
    { role: "system", content: COMPACT_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Conversation to summarize:\n\n${transcript}\n\n---\n\n${COMPACT_INSTRUCTIONS}`,
    },
  ];
}

async function generateSummary(oldMessages: Message[], options: LLMCompactOptions): Promise<string> {
  const messages = buildCompactionPromptMessages(oldMessages);
  return options.provider.complete(messages, {
    model: options.model,
    temperature: 0.2,
    thinkingLevel: options.thinkingLevel ?? "off",
  });
}

export function serializeTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        lines.push(`[user] ${contentToText(message.content)}`);
        break;
      case "assistant":
        if (message.content) lines.push(`[assistant] ${message.content}`);
        for (const toolCall of message.toolCalls ?? []) {
          lines.push(`[assistant tool_call] ${toolCall.name}(${toolCall.arguments})`);
        }
        break;
      case "tool":
        lines.push(`[tool] ${truncate(message.content, 800)}`);
        break;
      case "system":
      case "meta":
        break;
    }
  }
  return lines.join("\n");
}

function contentToText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join(" ");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

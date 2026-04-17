/**
 * LLM-backed structured conversation compaction.
 *
 * Generates a 9-section summary of the older turns via the provider's
 * completion API, replacing the dropped history with a single system
 * message. Falls back to the heuristic `compactMessages` if the LLM call
 * fails.
 */

import { compactMessages as compactMessagesHeuristic } from "./compact.js";
import type { CompactOptions, CompactResult } from "./compact.js";
import type { Message, Provider, ToolCall } from "../types.js";

export interface LLMCompactOptions extends CompactOptions {
  provider: Provider;
  model: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to produce a structured
summary of an earlier portion of a software-engineering assistant's
conversation so that the assistant can continue working without the full
history. Preserve fidelity over brevity where the user's intent, file
paths, or decisions are concerned. Output ONLY the summary, no preamble.`;

const COMPACT_INSTRUCTIONS = `Summarize the conversation above using exactly these 9 sections, each
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
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const turnStartIndexes = nonSystemMessages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);

  if (turnStartIndexes.length <= keepRecentTurns) {
    return { compacted: false };
  }

  const keepStartIndex = turnStartIndexes[Math.max(0, turnStartIndexes.length - keepRecentTurns)];
  if (keepStartIndex <= 0) {
    return { compacted: false };
  }

  const oldMessages = nonSystemMessages.slice(0, keepStartIndex);
  const keptMessages = nonSystemMessages.slice(keepStartIndex);

  let summary: string;
  try {
    summary = await generateSummary(oldMessages, options);
  } catch {
    return compactMessagesHeuristic(messages, { keepRecentTurns, maxSummaryItems: options.maxSummaryItems });
  }

  if (!summary.trim()) {
    return compactMessagesHeuristic(messages, { keepRecentTurns, maxSummaryItems: options.maxSummaryItems });
  }

  return {
    compacted: true,
    summary,
    messages: [
      ...systemMessages,
      { role: "system", content: `Previous conversation summary:\n${summary}` },
      ...keptMessages,
    ],
    droppedEntries: oldMessages.length,
  };
}

async function generateSummary(oldMessages: Message[], options: LLMCompactOptions): Promise<string> {
  const transcript = serializeTranscript(oldMessages);
  const messages: Message[] = [
    { role: "system", content: COMPACT_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Conversation to summarize:\n\n${transcript}\n\n---\n\n${COMPACT_INSTRUCTIONS}`,
    },
  ];
  return options.provider.complete(messages, {
    model: options.model,
    temperature: 0.2,
    thinkingLevel: options.thinkingLevel ?? "off",
  });
}

function serializeTranscript(messages: Message[]): string {
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

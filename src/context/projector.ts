import { getContextBudget } from "./budget.js";
import { compactCurrentTurnToolGroups, compactMessages } from "./compact.js";
import { pruneMessages } from "./prune.js";
import type { AssistantMessage, Message, MetaMessage, ProviderMessage, SystemMessage, ToolMessage } from "../types.js";

export interface ProjectionOptions {
  mode?: "full" | "pruned" | "budgeted";
  providerId?: string;
  modelId?: string;
  usageAnchorTokens?: number;
  anchorMessageCount?: number;
}

// Prefix-cache invariant: every projected output starts with the concatenation
// of (in order) system + meta messages from the input, followed by the
// conversational body. Compactors (compactMessages, compactCurrentTurnToolGroups,
// compactMessagesWithLLM, compactWithLLM) MUST preserve every existing
// system/meta message in its original position so the cacheable prefix
// stays byte-identical across turns where compaction didn't fire. Inserting
// new dynamic content (summaries, etc.) AFTER system+meta is safe; inserting
// it within or before them is not.
export function projectMessages(messages: Message[], options: ProjectionOptions = {}): ProviderMessage[] {
  const mode = options.mode ?? "full";
  const projectedBody: ProviderMessage[] = [];
  const systemContext: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemContext.push(message.content);
      continue;
    }

    if (message.role === "meta") {
      if (message.includeInLlm !== false) {
        systemContext.push(formatMetaMessage(message));
      }
      continue;
    }

    if (message.role === "assistant" && isEmptyAssistantMessage(message)) {
      continue;
    }

    projectedBody.push(cloneMessage(message));
  }

  const projected: ProviderMessage[] = [
    ...(systemContext.length > 0
      ? [{
          role: "system",
          content: systemContext.join("\n\n"),
        } satisfies SystemMessage]
      : []),
    ...projectedBody,
  ];

  const repaired = repairToolCallChains(projected);

  if (mode === "pruned") {
    return pruneMessages(repaired);
  }

  if (mode === "budgeted") {
    const pruned = pruneMessages(repaired);
    if (!options.providerId || !options.modelId) {
      return pruned;
    }

    const budget = getContextBudget(
      options.providerId,
      options.modelId,
      pruned,
      options.usageAnchorTokens !== undefined && options.anchorMessageCount !== undefined
        ? {
            usageAnchorTokens: options.usageAnchorTokens,
            tailMessages: pruned.slice(Math.min(options.anchorMessageCount, pruned.length)),
          }
        : undefined,
    );
    if (!budget.shouldCompact) {
      return pruned;
    }

    // Escalating compaction: turn-level passes first, then sub-turn (single-turn
    // bloat from many tool calls) as a finer-grained fallback. Each step only
    // advances `working` if compaction actually fired, and re-checks the budget
    // before deciding to escalate further.
    let working: Message[] = pruned;

    const passes: Array<() => Message[] | undefined> = [
      () => compactMessages(working, { keepRecentTurns: 2 }).messages,
      () => compactMessages(working, { keepRecentTurns: 1 }).messages,
      () => compactCurrentTurnToolGroups(working, { keepRecentGroups: 2 }).messages,
      () => compactCurrentTurnToolGroups(working, { keepRecentGroups: 1 }).messages,
    ];

    for (const pass of passes) {
      const next = pass();
      if (next) working = next;
      const after = getContextBudget(options.providerId, options.modelId, working);
      if (!after.shouldCompact) break;
    }

    return repairToolCallChains(working as ProviderMessage[]);
  }

  return repaired;
}

/**
 * Ensures every assistant `tool_calls` is followed (in order) by tool messages
 * responding to each tool_call_id, with no foreign messages interleaved.
 *
 * This is a defensive sanitizer for the OpenAI/Kimi API contract — any drift
 * (a meta system-reminder injected mid-turn, a streaming bug, a session
 * resumed mid-tool-execution, a compaction split that drops a tool result)
 * would otherwise produce a 400 like:
 *
 *   "tool_call_ids did not have response messages: edit:6"
 *
 * Strategy: for each assistant with tool_calls, gather any matching tool
 * messages from the trailing window, drop orphan/interleaving entries, and
 * synthesize placeholder tool messages for any tool_call_id with no captured
 * result. Other messages keep their original order.
 */
export function repairToolCallChains(messages: ProviderMessage[]): ProviderMessage[] {
  const result: ProviderMessage[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    const msg = messages[i];

    if (msg.role === "tool") {
      // Orphan tool message (no preceding assistant tool_call claims it). Drop it —
      // the API rejects orphan tool messages too.
      continue;
    }

    result.push(msg);

    if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) {
      continue;
    }

    // Collect tool messages immediately following the assistant turn (allowing
    // foreign messages in between to be skipped, then re-emitted in their
    // original positions later).
    const matched = new Map<string, ToolMessage>();
    const expected = new Set(msg.toolCalls.map((tc) => tc.id));
    for (let j = i + 1; j < messages.length && expected.size > 0; j++) {
      const next = messages[j];
      if (next.role !== "tool") continue;
      if (!expected.has(next.toolCallId)) {
        // Orphan tool message — mark consumed so we don't emit it later.
        consumed.add(j);
        continue;
      }
      matched.set(next.toolCallId, next);
      expected.delete(next.toolCallId);
      consumed.add(j);
    }

    for (const tc of msg.toolCalls) {
      const existing = matched.get(tc.id);
      if (existing) {
        result.push(existing);
      } else {
        result.push({
          role: "tool",
          toolCallId: tc.id,
          content: `[no result captured for tool call ${tc.name} (${tc.id})]`,
        });
      }
    }
  }

  return result;
}

function isEmptyAssistantMessage(message: AssistantMessage): boolean {
  const hasContent = message.content.trim().length > 0;
  const hasReasoning = (message.reasoning ?? "").trim().length > 0;
  const hasToolCalls = !!message.toolCalls && message.toolCalls.length > 0;
  return !hasContent && !hasReasoning && !hasToolCalls;
}

function formatMetaMessage(message: MetaMessage): string {
  switch (message.kind) {
    case "system-reminder":
      return `Runtime reminder:\n${message.content}`;
    case "runtime-context":
    default:
      return `Runtime context:\n${message.content}`;
  }
}

function cloneMessage(message: ProviderMessage): ProviderMessage {
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

import { getContextBudget } from "./budget.js";
import { compactMessages } from "./compact.js";
import { pruneMessages } from "./prune.js";
import type { AssistantMessage, Message, SystemMessage, ToolMessage } from "../types.js";

export interface ProjectionOptions {
  mode?: "full" | "pruned" | "budgeted";
  providerId?: string;
  modelId?: string;
  usageAnchorTokens?: number;
  anchorMessageCount?: number;
}

export function projectMessages(messages: Message[], options: ProjectionOptions = {}): Message[] {
  const mode = options.mode ?? "full";
  const projected: Message[] = [];
  let systemBuffer: string[] = [];

  const flushSystemBuffer = () => {
    if (systemBuffer.length === 0) return;
    projected.push({
      role: "system",
      content: systemBuffer.join("\n\n"),
    } satisfies SystemMessage);
    systemBuffer = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      systemBuffer.push(message.content);
      continue;
    }

    flushSystemBuffer();

    if (message.role === "assistant" && isEmptyAssistantMessage(message)) {
      continue;
    }

    projected.push(cloneMessage(message));
  }

  flushSystemBuffer();

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

    const compacted = compactMessages(pruned, { keepRecentTurns: 2 });
    if (!compacted.compacted || !compacted.messages) {
      return pruned;
    }

    const afterFirstPass = getContextBudget(options.providerId, options.modelId, compacted.messages);
    if (!afterFirstPass.shouldCompact) {
      return repairToolCallChains(compacted.messages);
    }

    const tighter = compactMessages(pruned, { keepRecentTurns: 1 });
    const finalMessages = tighter.compacted && tighter.messages ? tighter.messages : compacted.messages;
    return repairToolCallChains(finalMessages);
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
export function repairToolCallChains(messages: Message[]): Message[] {
  const result: Message[] = [];
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

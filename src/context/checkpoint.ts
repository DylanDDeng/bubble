import { randomUUID } from "node:crypto";
import type { Message } from "../types.js";
import { isInternalBlockOnlyContent, sanitizeInternalReminderBlocks, sanitizeInternalReasoningText, sanitizeAssistantProviderMetadata } from "../agent/internal-reminder-sanitizer.js";
import { isCompactionSummaryMessage, splitLeadingContext } from "./compact.js";

/** A versioned, exact conversational projection. Never includes the host system prompt. */
export interface ContextCheckpoint {
  version: 1;
  compactionId: string;
  reason: "auto" | "manual" | "overflow" | "resident";
  baseRevision?: string;
  summary?: string;
  messages: Message[];
}

export function createContextCheckpoint(
  messages: Message[],
  reason: ContextCheckpoint["reason"],
  summary?: string,
  baseRevision?: string,
): ContextCheckpoint {
  const { body } = splitLeadingContext(messages);
  // Runtime reminders must be recomputed by the host. Compaction summaries are
  // first-class context, not ephemeral reminders, and must survive verbatim.
  const durable = body.filter(message => {
    if (isCompactionSummaryMessage(message)) return true;
    if (message.role === "meta") return false;
    // Backstop for older histories containing provider-projected reminders.
    // Never remove user prose merely because it mentions or quotes a block.
    return !(message.role === "user" && typeof message.content === "string"
      && isInternalBlockOnlyContent(message.content)
      && !sanitizeInternalReminderBlocks(message.content).trim());
  });
  const sanitized = durable.map(message => message.role === "assistant" ? {
    ...message,
    content: sanitizeInternalReminderBlocks(message.content),
    ...(message.reasoning !== undefined ? { reasoning: sanitizeInternalReasoningText(message.reasoning) } : {}),
    ...(message.providerMetadata ? { providerMetadata: sanitizeAssistantProviderMetadata(message.providerMetadata) } : {}),
  } : message);
  return { version: 1, compactionId: randomUUID(), reason, baseRevision,
    summary: summary === undefined ? undefined : sanitizeInternalReminderBlocks(summary),
    messages: structuredClone(sanitized) };
}

/** Live meta reminders may interleave results, but every canonical call needs a real result. */
export function hasCompleteToolGroups(messages: Message[]): boolean {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "meta") continue;
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) return false;
    } else {
      if (pending.size) return false;
      if (message.role === "assistant") {
        for (const call of message.toolCalls ?? []) {
          if (!call.id || seen.has(call.id)) return false;
          pending.add(call.id);
          seen.add(call.id);
        }
      }
    }
  }
  return pending.size === 0;
}

export function checkpointMessages(checkpoint: ContextCheckpoint): Message[] {
  if (checkpoint?.version !== 1 || typeof checkpoint.compactionId !== "string" || !checkpoint.compactionId
    || !Array.isArray(checkpoint.messages)) throw new Error("Unsupported context checkpoint");
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of checkpoint.messages) {
    if (!message || !["user", "assistant", "tool", "system", "meta"].includes(message.role)
      || !(typeof message.content === "string" || (message.role === "user" && Array.isArray(message.content)))) {
      throw new Error("Invalid context checkpoint message");
    }
    if (message.role === "assistant") {
      if (pending.size) throw new Error("Incomplete checkpoint tool group");
      for (const call of message.toolCalls ?? []) {
        if (!call.id || seen.has(call.id)) throw new Error("Invalid checkpoint tool call id");
        pending.add(call.id); seen.add(call.id);
      }
    } else if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) throw new Error("Orphan checkpoint tool result");
    } else if (pending.size) throw new Error("Interrupted checkpoint tool group");
  }
  if (pending.size) throw new Error("Incomplete checkpoint tool group");
  return structuredClone(checkpoint.messages.map(message => message.role === "assistant" ? {
    ...message,
    content: sanitizeInternalReminderBlocks(message.content),
    ...(message.reasoning !== undefined ? { reasoning: sanitizeInternalReasoningText(message.reasoning) } : {}),
    ...(message.providerMetadata ? { providerMetadata: sanitizeAssistantProviderMetadata(message.providerMetadata) } : {}),
  } : message));
}

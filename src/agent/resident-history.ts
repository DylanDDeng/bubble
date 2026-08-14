/**
 * Resident-history size estimation and the cliff-edge guards that decide when
 * in-memory history is compacted (see docs/harness-thinning.md, wave 2).
 */
import { isRealUserMessage } from "../context/compact.js";
import type { Message } from "../types.js";

export const RESIDENT_HISTORY_KEEP_RECENT_TURNS = 3;
export const RESIDENT_HISTORY_HEAP_HARD_LIMIT = 768 * 1024 * 1024;

export function estimateResidentChars(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "meta":
        total += message.content.length;
        break;
      case "tool":
        total += message.content.length + message.toolCallId.length;
        break;
      case "assistant":
        total += message.content.length + (message.reasoning?.length ?? 0);
        total += message.toolCalls?.reduce(
          (sum, toolCall) => sum + toolCall.id.length + toolCall.name.length + toolCall.arguments.length,
          0,
        ) ?? 0;
        break;
      case "user":
        if (typeof message.content === "string") {
          total += message.content.length;
        } else {
          total += message.content.reduce((sum, part) => {
            if (part.type === "text") {
              return sum + part.text.length;
            }
            return sum + part.image_url.url.length;
          }, 0);
        }
        break;
    }
  }

  return total;
}

export function estimateToolPayloadChars(messages: Message[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== "tool") {
      return sum;
    }
    return sum + message.content.length;
  }, 0);
}

export function countUserTurns(messages: Message[]): number {
  // Real user turns only: projected reminders and summary envelopes are
  // user-ROLE but not user TURNS — counting them used to shrink the keep
  // window and fire compaction almost every turn.
  return messages.reduce((count, message) => count + (isRealUserMessage(message) ? 1 : 0), 0);
}

export function getCurrentHeapUsed(): number {
  try {
    return process.memoryUsage().heapUsed;
  } catch {
    return 0;
  }
}

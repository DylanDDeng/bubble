import type { AssistantMessage, Message, ToolCall, ToolMessage } from "../types.js";

const PRUNEABLE_TOOLS = new Set([
  "read", "bash", "grep", "web_search", "web_fetch", "edit", "write", "glob",
]);
const TOOL_RESULT_KEEP_COUNT = 2;
const MIN_PRUNE_LENGTH = 240;

export function pruneMessages(messages: Message[]): Message[] {
  const toolNameByCallId = new Map<string, string>();
  const pruneCandidates: Array<{ index: number; toolName: string; message: ToolMessage }> = [];
  const protectedToolCallIds = collectProtectedToolCallIds(messages);
  let protectedRetainedCount = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        toolNameByCallId.set(toolCall.id, toolCall.name);
      }
      continue;
    }

    if (message.role !== "tool") {
      continue;
    }

    if (protectedToolCallIds.has(message.toolCallId)) {
      const toolName = toolNameByCallId.get(message.toolCallId);
      if (toolName && shouldPruneToolResult(toolName, message.content)) {
        protectedRetainedCount += 1;
      }
      continue;
    }

    const toolName = toolNameByCallId.get(message.toolCallId);
    if (!toolName || !shouldPruneToolResult(toolName, message.content)) {
      continue;
    }

    pruneCandidates.push({ index, toolName, message });
  }

  const keepBudget = Math.max(0, TOOL_RESULT_KEEP_COUNT - protectedRetainedCount);
  const keepFrom = Math.max(0, pruneCandidates.length - keepBudget);
  const keepIndexes = new Set(pruneCandidates.slice(keepFrom).map((candidate) => candidate.index));

  return messages.map((message, index) => {
    if (message.role !== "tool" || keepIndexes.has(index)) {
      return message;
    }

    const candidate = pruneCandidates.find((item) => item.index === index);
    if (!candidate) {
      return message;
    }

    return {
      ...message,
      content: summarizePrunedToolResult(candidate.toolName, candidate.message.content),
    };
  });
}

function shouldPruneToolResult(toolName: string, content: string): boolean {
  if (!PRUNEABLE_TOOLS.has(toolName)) {
    return false;
  }

  if (content.length < MIN_PRUNE_LENGTH) {
    return false;
  }

  if (content.startsWith("Error")) {
    return false;
  }

  return true;
}

function summarizePrunedToolResult(toolName: string, content: string): string {
  return `[${toolName} output omitted to control context size; original length ${content.length} chars]`;
}

/**
 * Aggressive variant of pruneMessages: drops the content of every prunable
 * tool output except the latest unresolved tool turn that the model still
 * needs to reason over. Used as a last-resort microcompact pass when a
 * standard prune hasn't reclaimed enough budget.
 */
export function aggressivePruneMessages(messages: Message[]): Message[] {
  const toolNameByCallId = new Map<string, string>();
  const protectedToolCallIds = collectProtectedToolCallIds(messages);
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        toolNameByCallId.set(toolCall.id, toolCall.name);
      }
    }
  }

  return messages.map((message) => {
    if (message.role !== "tool") return message;
    if (protectedToolCallIds.has(message.toolCallId)) {
      return message;
    }
    const toolName = toolNameByCallId.get(message.toolCallId);
    if (!toolName || !shouldPruneToolResult(toolName, message.content)) {
      return message;
    }
    return { ...message, content: summarizePrunedToolResult(toolName, message.content) };
  });
}

function collectProtectedToolCallIds(messages: Message[]): Set<string> {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "tool" || message.role === "system") {
      continue;
    }
    if (message.role === "user" && message.isMeta) {
      continue;
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return new Set(message.toolCalls.map((toolCall) => toolCall.id));
    }
    break;
  }

  return new Set();
}

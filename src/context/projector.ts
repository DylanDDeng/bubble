import { getContextBudget } from "./budget.js";
import { compactMessages } from "./compact.js";
import { pruneMessages } from "./prune.js";
import type { AssistantMessage, Message, SystemMessage } from "../types.js";

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

  if (mode === "pruned") {
    return pruneMessages(projected);
  }

  if (mode === "budgeted") {
    const pruned = pruneMessages(projected);
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
      return compacted.messages;
    }

    const tighter = compactMessages(pruned, { keepRecentTurns: 1 });
    return tighter.compacted && tighter.messages ? tighter.messages : compacted.messages;
  }

  return projected;
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

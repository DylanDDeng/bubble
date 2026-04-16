import { pruneMessages } from "./prune.js";
import type { AssistantMessage, Message, SystemMessage } from "../types.js";

export interface ProjectionOptions {
  mode?: "full" | "pruned";
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

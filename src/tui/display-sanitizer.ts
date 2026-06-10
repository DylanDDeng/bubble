import {
  sanitizeInternalReasoningText,
  sanitizeInternalReminderBlocks,
} from "../agent/internal-reminder-sanitizer.js";
import type { DisplayMessage, DisplayMessagePart } from "./display-history.js";

export function sanitizeDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.map(sanitizeDisplayMessage);
}

export function sanitizeDisplayMessage(message: DisplayMessage): DisplayMessage {
  if (message.role !== "assistant") return message;

  const content = sanitizeInternalReminderBlocks(message.content);
  const reasoning = message.reasoning !== undefined
    ? sanitizeInternalReasoningText(message.reasoning)
    : undefined;
  const sanitizedParts = message.parts
    ?.map(sanitizeDisplayPart)
    .filter(isRenderableDisplayPart);
  const parts = sanitizedParts && sanitizedParts.length > 0 ? sanitizedParts : undefined;

  if (
    content === message.content
    && reasoning === message.reasoning
    && parts === message.parts
  ) {
    return message;
  }

  return {
    ...message,
    content,
    reasoning,
    parts,
  };
}

function sanitizeDisplayPart(part: DisplayMessagePart): DisplayMessagePart {
  if (part.type !== "text") return part;
  const content = sanitizeInternalReminderBlocks(part.content);
  return content === part.content ? part : { ...part, content };
}

function isRenderableDisplayPart(part: DisplayMessagePart): boolean {
  if (part.type === "text") return !!part.content.trim();
  return part.toolCalls.length > 0;
}

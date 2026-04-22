export interface DisplayMessage {
  role: "user" | "assistant" | "error";
  content: string;
  reasoning?: string;
  toolCalls?: DisplayToolCall[];
  syntheticKind?: "ui_summary";
  hiddenCount?: number;
}

export interface DisplayToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: string;
  isError?: boolean;
}

const MAX_VISIBLE_MESSAGES = 80;
const FULL_DETAIL_WINDOW = 24;
const MAX_OLD_CONTENT_CHARS = 1200;
const MAX_OLD_REASONING_CHARS = 600;
const MAX_OLD_TOOL_RESULT_CHARS = 800;

export function compactDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  let hiddenCount = 0;
  const withoutSynthetic = messages.filter((message) => {
    if (message.syntheticKind !== "ui_summary") {
      return true;
    }
    hiddenCount += message.hiddenCount ?? 0;
    return false;
  });

  const overflow = Math.max(0, withoutSynthetic.length - MAX_VISIBLE_MESSAGES);
  hiddenCount += overflow;
  const visible = overflow > 0 ? withoutSynthetic.slice(overflow) : withoutSynthetic;
  const detailStart = Math.max(0, visible.length - FULL_DETAIL_WINDOW);
  const compacted = visible.map((message, index) => (
    index < detailStart ? compactDisplayMessage(message) : message
  ));

  if (hiddenCount === 0) {
    return compacted;
  }

  return [buildUiSummary(hiddenCount), ...compacted];
}

function compactDisplayMessage(message: DisplayMessage): DisplayMessage {
  if (message.syntheticKind === "ui_summary") {
    return message;
  }

  return {
    ...message,
    content: truncateText(message.content, MAX_OLD_CONTENT_CHARS),
    reasoning: message.reasoning
      ? truncateText(message.reasoning, MAX_OLD_REASONING_CHARS)
      : message.reasoning,
    toolCalls: message.toolCalls?.map((toolCall) => ({
      ...toolCall,
      result: toolCall.result
        ? truncateText(toolCall.result, MAX_OLD_TOOL_RESULT_CHARS)
        : toolCall.result,
    })),
  };
}

function buildUiSummary(hiddenCount: number): DisplayMessage {
  return {
    role: "assistant",
    content: `[Earlier UI history compacted to control memory: ${hiddenCount} message${hiddenCount === 1 ? "" : "s"} hidden]`,
    syntheticKind: "ui_summary",
    hiddenCount,
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const head = Math.max(1, Math.floor(maxChars * 0.7));
  const tail = Math.max(1, maxChars - head - 32);
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}\n...[${omitted} chars omitted for UI]...\n${value.slice(-tail)}`;
}

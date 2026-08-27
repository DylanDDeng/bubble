import { getContextBudget } from "./budget.js";
import { compactCurrentTurnToolGroups, compactMessages } from "./compact.js";
import { pruneMessages } from "./prune.js";
import { formatInternalContextBlock, formatInternalReminderBlock } from "../agent/internal-reminder-sanitizer.js";
import type { AssistantMessage, Message, MetaMessage, ProviderMessage, SystemMessage, ToolMessage } from "../types.js";
import {
  DEFAULT_TOOL_OUTPUT_BYTE_LIMIT,
  TOOL_OUTPUT_BATCH_BYTE_LIMIT,
  truncateToolOutputForModel,
} from "./tool-output-truncate.js";

export interface ProjectionOptions {
  mode?: "full" | "pruned" | "budgeted";
  providerId?: string;
  modelId?: string;
  usageAnchorTokens?: number;
  anchorMessageCount?: number;
  /** Request tokens not represented by messages, such as active tool schemas. */
  additionalInputTokens?: number;
}

// Prefix-cache invariant: only the leading static system prompt is promoted to
// the first provider message. Runtime meta reminders stay in the conversational
// body at their original relative position, so a new per-turn reminder does not
// rewrite the cacheable prefix before the existing history.
export function projectMessages(messages: Message[], options: ProjectionOptions = {}): ProviderMessage[] {
  const mode = options.mode ?? "full";
  const projectedBody: ProviderMessage[] = [];
  const systemContext: string[] = [];
  let inLeadingSystemPrefix = true;

  for (const message of messages) {
    if (message.role === "system" && inLeadingSystemPrefix) {
      systemContext.push(message.content);
      continue;
    }

    if (message.role === "meta") {
      inLeadingSystemPrefix = false;
      if (message.includeInLlm !== false) {
        projectedBody.push({
          role: "user",
          content: formatMetaMessage(message),
        });
      }
      continue;
    }

    inLeadingSystemPrefix = false;

    if (message.role === "system") {
      projectedBody.push({
        role: "user",
        content: formatRuntimeSystemMessage(message),
      });
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
  const bounded = options.providerId && options.modelId
    ? boundToolOutputBatches(repaired, options.providerId, options.modelId)
    : repaired;

  if (mode === "pruned") {
    return pruneMessages(bounded);
  }

  if (mode === "budgeted") {
    const pruned = pruneMessages(bounded);
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
            additionalInputTokens: options.additionalInputTokens,
          }
        : { additionalInputTokens: options.additionalInputTokens },
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
      const after = getContextBudget(options.providerId, options.modelId, working, {
        additionalInputTokens: options.additionalInputTokens,
      });
      if (!after.shouldCompact) break;
    }

    // Compaction passes emit summaries as meta messages (first-class identity);
    // the provider payload must stay provider-safe, so render them here the
    // same way body meta messages are rendered above.
    const providerSafe = working.map((message) =>
      message.role === "meta"
        ? { role: "user" as const, content: formatMetaMessage(message) }
        : message);

    return boundToolOutputBatches(
      repairToolCallChains(providerSafe as ProviderMessage[]),
      options.providerId,
      options.modelId,
    );
  }

  return bounded;
}

/**
 * Re-bound restored tool messages and divide a hard aggregate budget fairly
 * across sibling calls. A historical 6MB JSONL entry therefore becomes safe
 * at projection time even if it predates live-result normalization.
 */
export function boundToolOutputBatches(
  messages: ProviderMessage[],
  providerId: string,
  modelId: string,
): ProviderMessage[] {
  const bounded: ProviderMessage[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    bounded.push(message);
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;

    const siblingCount = message.toolCalls.length;
    const perResultByteLimit = Math.min(
      DEFAULT_TOOL_OUTPUT_BYTE_LIMIT,
      Math.floor(TOOL_OUTPUT_BATCH_BYTE_LIMIT / siblingCount),
    );
    for (let sibling = 0; sibling < siblingCount; sibling++) {
      const toolMessage = messages[index + 1 + sibling];
      if (!toolMessage || toolMessage.role !== "tool") break;
      const result = truncateToolOutputForModel(
        toolMessage.content,
        providerId,
        modelId,
        { hardByteLimit: perResultByteLimit },
      );
      bounded.push(result.truncated
        ? {
            ...toolMessage,
            content: result.content,
            metadata: {
              ...toolMessage.metadata,
              truncated: true,
              toolOutputTruncation: {
                originalBytes: result.originalBytes,
                finalBytes: result.finalBytes,
                originalTokens: result.originalTokens,
                finalTokens: result.finalTokens,
                hardByteLimit: result.hardByteLimit,
                ...(result.limit ? { modelTokenLimit: result.limit } : {}),
              },
            },
          }
        : toolMessage);
    }
    index += siblingCount;
  }

  return bounded;
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
  const hasToolCalls = !!message.toolCalls && message.toolCalls.length > 0;
  // Reasoning-only assistant messages are not valid ChatCompletions history:
  // providers require assistant history to contain user-visible content or
  // tool_calls. Keep reasoning attached to real assistant/tool-call messages,
  // but drop standalone thinking-only turns before provider projection.
  return !hasContent && !hasToolCalls;
}

function formatMetaMessage(message: MetaMessage): string {
  switch (message.kind) {
    case "system-reminder":
      return formatInternalReminderBlock(message.kind, message.content);
    case "runtime-context":
    default:
      return formatInternalContextBlock(message.kind, message.content);
  }
}

function formatRuntimeSystemMessage(message: SystemMessage): string {
  return formatInternalContextBlock("runtime-system", message.content);
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

import { createHash } from "node:crypto";
import {
  sanitizeAssistantProviderMetadata,
  sanitizeInternalReasoningText,
  sanitizeInternalReminderBlocks,
} from "./agent/internal-reminder-sanitizer.js";
import type { AssistantMessage, Message } from "./types.js";
import type {
  LegacySessionEntry,
  SessionAssistantMessageEntry,
  SessionLogEntry,
  SessionMarkerKind,
  SessionMetadata,
  SessionMetadataEntry,
  SessionProviderErrorEntry,
  SessionSummaryEntry,
} from "./session-types.js";
import type { SanitizedProviderError } from "./provider-error-record.js";
import { checkpointMessages } from "./context/checkpoint.js";

/** Records that change conversational context or its execution state.
 * Keep this shared by revision hashing and checkpoint receipt supersession.
 * Unknown/new markers are conservative: only known diagnostics are excluded.
 */
export function affectsContextRevision(entry: SessionLogEntry): boolean {
  if (entry.type === "metadata" || entry.type === "provider_error") return false;
  if (entry.type === "marker") {
    return !["task_started", "task_finished", "task_killed"].includes(entry.kind);
  }
  return true;
}

export class SessionLog {
  private entries: SessionLogEntry[] = [];
  private nextId = 1;
  private contextRevision = "empty";

  private allocateId(): string { return String(this.nextId++); }

  appendEntries(entries: SessionLogEntry[]): void {
    this.entries.push(...entries);
    for (const entry of entries) {
      this.nextId = Math.max(this.nextId, (parseInt(entry.id, 10) || 0) + 1);
      if (affectsContextRevision(entry)) {
        this.contextRevision = createHash("sha256").update(this.contextRevision).update(JSON.stringify(entry)).digest("hex");
      }
    }
  }

  getRevision(): string { return this.contextRevision; }

  load(lines: string[]) {
    this.entries = [];
    this.nextId = 1;
    this.contextRevision = "empty";
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as SessionLogEntry | LegacySessionEntry;
        this.appendEntries(normalizeEntry(raw));
      } catch {
        // skip corrupt lines
      }
    }
  }

  replace(entries: SessionLogEntry[]) {
    this.entries = [];
    this.nextId = 1;
    this.contextRevision = "empty";
    this.appendEntries(entries);
  }

  list(): SessionLogEntry[] {
    return [...this.entries];
  }

  getMetadata(): SessionMetadata {
    let entry: SessionMetadataEntry | undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const item = this.entries[i];
      if (item.type === "metadata") { entry = item; break; }
    }
    const metadata = entry?.metadata ?? {};
    return {
      ...metadata,
      thinkingLevel: metadata.thinkingLevel ?? metadata.reasoningEffort,
    };
  }

  setMetadata(metadata: SessionMetadata): SessionLogEntry[] {
    const next = [...this.entries];
    const entry: SessionMetadataEntry = {
      id: "metadata",
      type: "metadata",
      metadata,
      timestamp: Date.now(),
    };
    const existingIndex = next.findIndex((item) => item.type === "metadata");
    if (existingIndex >= 0) {
      next[existingIndex] = entry;
    } else {
      next.unshift(entry);
    }
    this.entries = next;
    return next;
  }

  appendMessage(message: Message): SessionLogEntry[] {
    const normalized = normalizeMessageToEntries(message, this.allocateId(), Date.now());
    this.appendEntries(normalized);
    return normalized;
  }

  appendSummary(summary: string): SessionSummaryEntry {
    const entry: SessionSummaryEntry = {
      id: this.allocateId(),
      type: "summary",
      summary,
      timestamp: Date.now(),
    };
    this.appendEntries([entry]);
    return entry;
  }

  appendMarker(kind: SessionMarkerKind, value: string): SessionLogEntry {
    const entry: SessionLogEntry = {
      id: this.allocateId(),
      type: "marker",
      kind,
      value,
      timestamp: Date.now(),
    };
    this.appendEntries([entry]);
    return entry;
  }

  appendProviderError(error: SanitizedProviderError): SessionProviderErrorEntry {
    const entry: SessionProviderErrorEntry = {
      id: this.allocateId(),
      type: "provider_error",
      error,
      timestamp: Date.now(),
    };
    this.appendEntries([entry]);
    return entry;
  }

  toMessages(): Message[] {
    const messages: Message[] = [];
    let latestSummaryIndex = -1;
    let latestClearIndex = -1;

    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].type === "summary" || this.entries[index].type === "context_checkpoint") {
        latestSummaryIndex = index;
        break;
      }
    }

    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (entry.type === "marker" && entry.kind === "conversation_clear") {
        latestClearIndex = index;
        break;
      }
    }

    if (latestSummaryIndex > latestClearIndex) {
      const entry = this.entries[latestSummaryIndex];
      if (entry.type === "context_checkpoint") {
        messages.push(...checkpointMessages(entry.checkpoint));
      } else if (entry.type === "summary") {
        // Legacy summaries remain readable; already discarded originals cannot be reconstructed.
        messages.push({ role: "system", content: `Previous conversation summary: ${entry.summary}` });
      }
    }

    const startIndex = Math.max(
      latestSummaryIndex > latestClearIndex ? latestSummaryIndex + 1 : 0,
      latestClearIndex + 1,
    );
    const committedPrefixLength = latestSummaryIndex > latestClearIndex
      && this.entries[latestSummaryIndex].type === "context_checkpoint" ? messages.length : 0;
    for (let index = startIndex; index < this.entries.length; index++) {
      const entry = this.entries[index];
      switch (entry.type) {
        case "user_message":
          messages.push(cloneMessage(entry.message));
          break;
        case "assistant_message":
          messages.push({
            ...entry.message,
            role: "assistant",
            content: sanitizeInternalReminderBlocks(entry.message.content),
            reasoning: entry.message.reasoning !== undefined
              ? sanitizeInternalReasoningText(entry.message.reasoning)
              : undefined,
            providerMetadata: sanitizeAssistantProviderMetadata(cloneProviderMetadata(entry.message.providerMetadata)),
          });
          break;
        case "tool_call": {
          const last = messages[messages.length - 1];
          if (last?.role === "assistant") {
            const assistant = last as AssistantMessage;
            assistant.toolCalls = [...(assistant.toolCalls ?? []), { ...entry.toolCall }];
          } else {
            messages.push({
              role: "assistant",
              content: "",
              toolCalls: [{ ...entry.toolCall }],
            });
          }
          break;
        }
        case "tool_result":
          messages.push(cloneMessage(entry.message));
          break;
        default:
          break;
      }
    }

    // A committed checkpoint may end in completed tools without a final text
    // response. It is a resumable model boundary, not an interrupted user turn.
    if (committedPrefixLength > 0) {
      const tail = messages.slice(committedPrefixLength);
      const nextUser = tail.findIndex(message => message.role === "user");
      const continuationEnd = nextUser < 0 ? tail.length : nextUser;
      return [
        ...messages.slice(0, committedPrefixLength),
        ...pruneIncompleteToolGroups(tail.slice(0, continuationEnd)),
        ...pruneIncompleteTail(tail.slice(continuationEnd)),
      ];
    }
    return pruneIncompleteTail(messages);
  }
}

function normalizeEntry(raw: SessionLogEntry | LegacySessionEntry): SessionLogEntry[] {
  if (isSessionLogEntry(raw)) {
    return [raw];
  }

  if (raw.type === "metadata") {
    return [{
      id: raw.id,
      type: "metadata",
      metadata: raw.metadata ?? {},
      timestamp: raw.timestamp,
    }];
  }

  if (raw.type === "compaction") {
    return [{
      id: raw.id,
      type: "summary",
      summary: raw.summary ?? "",
      timestamp: raw.timestamp,
    }];
  }

  if (raw.type === "message" && raw.data) {
    return normalizeMessageToEntries(raw.data, raw.id, raw.timestamp);
  }

  return [];
}

function normalizeMessageToEntries(message: Message, id: string, timestamp: number): SessionLogEntry[] {
  switch (message.role) {
    case "user":
      return [{ id, type: "user_message", message, timestamp }];
    case "assistant": {
      const assistantEntry: SessionAssistantMessageEntry = {
        id,
        type: "assistant_message",
        message: {
          role: "assistant",
          content: sanitizeInternalReminderBlocks(message.content),
          reasoning: message.reasoning !== undefined
            ? sanitizeInternalReasoningText(message.reasoning)
            : undefined,
          model: message.model,
          providerId: message.providerId,
          modelId: message.modelId,
          usage: message.usage,
          systemFingerprint: message.systemFingerprint,
          error: message.error,
          providerMetadata: sanitizeAssistantProviderMetadata(cloneProviderMetadata(message.providerMetadata)),
        },
        timestamp,
      };

      const toolCallEntries = (message.toolCalls ?? []).map((toolCall, index) => ({
        id: `${id}:tool:${index + 1}`,
        type: "tool_call" as const,
        toolCall,
        timestamp,
      }));

      return [assistantEntry, ...toolCallEntries];
    }
    case "tool":
      return [{ id, type: "tool_result", message, timestamp }];
    case "meta":
      return [];
    case "system":
      return [{
        id,
        type: "summary",
        summary: message.content,
        timestamp,
      }];
  }
}

function isSessionLogEntry(entry: SessionLogEntry | LegacySessionEntry): entry is SessionLogEntry {
  return [
    "metadata",
    "context_checkpoint",
    "summary",
    "marker",
    "user_message",
    "assistant_message",
    "tool_call",
    "tool_result",
    "provider_error",
  ].includes(entry.type);
}

function cloneMessage(message: Message): Message {
  if (message.role === "assistant") {
    return {
      ...message,
      toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
      providerMetadata: cloneProviderMetadata(message.providerMetadata),
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

function cloneProviderMetadata<T>(metadata: T | undefined): T | undefined {
  if (metadata === undefined) return undefined;
  return JSON.parse(JSON.stringify(metadata)) as T;
}

// A checkpoint can split a user turn. Its continuation has no user anchor,
// so validate complete tool groups directly rather than relying on turn pruning.
function pruneIncompleteToolGroups(messages: Message[]): Message[] {
  const pending = new Set<string>();
  let groupStart = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "system" || message.role === "meta") continue;
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) return messages.slice(0, groupStart < 0 ? index : groupStart);
      if (pending.size === 0) groupStart = -1;
    } else {
      if (pending.size) return messages.slice(0, groupStart);
      if (message.role === "assistant" && message.toolCalls?.length) {
        groupStart = index;
        for (const call of message.toolCalls) {
          if (!call.id || pending.has(call.id)) return messages.slice(0, groupStart);
          pending.add(call.id);
        }
      }
    }
  }
  return pending.size ? messages.slice(0, groupStart) : messages;
}

function pruneIncompleteTail(messages: Message[]): Message[] {
  let currentTurnStart = -1;
  let hasCompletedAssistant = false;
  let sawNonUserInCurrentTurn = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "system" || message.role === "meta") continue;

    if (message.role === "user") {
      currentTurnStart = i;
      hasCompletedAssistant = false;
      sawNonUserInCurrentTurn = false;
      continue;
    }

    if (currentTurnStart === -1) {
      continue;
    }

    sawNonUserInCurrentTurn = true;

    if (message.role === "assistant") {
      const hasPendingTools = !!message.toolCalls && message.toolCalls.length > 0;
      if (!hasPendingTools) {
        hasCompletedAssistant = true;
      }
    }
  }

  if (currentTurnStart >= 0 && sawNonUserInCurrentTurn && !hasCompletedAssistant) {
    return messages.slice(0, currentTurnStart);
  }

  return messages;
}

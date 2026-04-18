import type { AssistantMessage, Message, Todo } from "./types.js";
import type {
  LegacySessionEntry,
  SessionAssistantMessageEntry,
  SessionLogEntry,
  SessionMarkerKind,
  SessionMetadata,
  SessionMetadataEntry,
  SessionSummaryEntry,
  SessionTodosSnapshotEntry,
} from "./session-types.js";

export class SessionLog {
  private entries: SessionLogEntry[] = [];

  load(lines: string[]) {
    this.entries = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as SessionLogEntry | LegacySessionEntry;
        this.entries.push(...normalizeEntry(raw));
      } catch {
        // skip corrupt lines
      }
    }
  }

  replace(entries: SessionLogEntry[]) {
    this.entries = entries;
  }

  list(): SessionLogEntry[] {
    return [...this.entries];
  }

  getMetadata(): SessionMetadata {
    const entry = this.entries.find((item): item is SessionMetadataEntry => item.type === "metadata");
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
    const normalized = normalizeMessageToEntries(message, nextEntryId(this.entries), Date.now());
    this.entries.push(...normalized);
    return normalized;
  }

  appendSummary(summary: string): SessionSummaryEntry {
    const entry: SessionSummaryEntry = {
      id: nextEntryId(this.entries),
      type: "summary",
      summary,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  appendTodosSnapshot(todos: Todo[]): SessionTodosSnapshotEntry {
    const entry: SessionTodosSnapshotEntry = {
      id: nextEntryId(this.entries),
      type: "todos_snapshot",
      todos: todos.map((todo) => ({ ...todo })),
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  getTodos(): Todo[] {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.type === "todos_snapshot") {
        return entry.todos.map((todo) => ({ ...todo }));
      }
    }
    return [];
  }

  appendMarker(kind: SessionMarkerKind, value: string): SessionLogEntry {
    const entry: SessionLogEntry = {
      id: nextEntryId(this.entries),
      type: "marker",
      kind,
      value,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  toMessages(): Message[] {
    const messages: Message[] = [];
    let latestSummaryIndex = -1;

    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].type === "summary") {
        latestSummaryIndex = index;
        break;
      }
    }

    if (latestSummaryIndex >= 0) {
      const summary = this.entries[latestSummaryIndex] as SessionSummaryEntry;
      messages.push({
        role: "system",
        content: `Previous conversation summary: ${summary.summary}`,
      });
    }

    const startIndex = latestSummaryIndex >= 0 ? latestSummaryIndex + 1 : 0;
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
          content: message.content,
          reasoning: message.reasoning,
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
    "summary",
    "marker",
    "user_message",
    "assistant_message",
    "tool_call",
    "tool_result",
    "todos_snapshot",
  ].includes(entry.type);
}

function nextEntryId(entries: SessionLogEntry[]): string {
  return `${entries.length + 1}`;
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

function pruneIncompleteTail(messages: Message[]): Message[] {
  let currentTurnStart = -1;
  let hasCompletedAssistant = false;
  let sawNonUserInCurrentTurn = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "system") continue;

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

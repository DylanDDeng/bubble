import type { AssistantMessage, Message, ThinkingLevel, Todo, ToolCall, ToolMessage, UserMessage } from "./types.js";
import type { GoalState } from "./goal/store.js";

export interface ExternalRuntimeSessionMetadata {
  /** External agent runtime that owns the conversational state. */
  id: "grok";
  /** Opaque ACP session identifier. Never contains credentials. */
  sessionId?: string;
  /** Server-selected model, when the runtime reports one. */
  modelId?: string;
  /** Reasoning effort selected for the external runtime. */
  reasoningEffort?: ThinkingLevel;
  /** Exact external runtime version used to create the session. */
  version?: string;
}

export interface SessionMetadata {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  reasoningEffort?: ThinkingLevel;
  cwd?: string;
  title?: string;
  titleSource?: "llm" | "manual";
  titleUpdatedAt?: number;
  titleUserMessageId?: string;
  promptCacheKey?: string;
  /** Persisted autonomous goal (see src/goal). Survives /session resume. */
  goal?: GoalState;
  /**
   * External runtimes keep their own conversation state. Bubble persists only
   * the opaque session binding and a UI transcript mirror; it never stores the
   * runtime's OAuth credentials.
   */
  externalRuntime?: ExternalRuntimeSessionMetadata;
}

export type SessionMarkerKind =
  | "model_switch"
  | "provider_switch"
  | "thinking_level_switch"
  | "skill_activated"
  | "mode_switch"
  | "runtime_switch"
  | "conversation_clear";

interface BaseSessionLogEntry {
  id: string;
  timestamp: number;
}

export interface SessionMetadataEntry extends BaseSessionLogEntry {
  type: "metadata";
  metadata: SessionMetadata;
}

export interface SessionSummaryEntry extends BaseSessionLogEntry {
  type: "summary";
  summary: string;
}

export interface SessionMarkerEntry extends BaseSessionLogEntry {
  type: "marker";
  kind: SessionMarkerKind;
  value: string;
}

export interface SessionUserMessageEntry extends BaseSessionLogEntry {
  type: "user_message";
  message: UserMessage;
}

export interface SessionAssistantMessageEntry extends BaseSessionLogEntry {
  type: "assistant_message";
  message: Omit<AssistantMessage, "toolCalls">;
}

export interface SessionToolCallEntry extends BaseSessionLogEntry {
  type: "tool_call";
  toolCall: ToolCall;
}

export interface SessionToolResultEntry extends BaseSessionLogEntry {
  type: "tool_result";
  message: ToolMessage;
}

export interface SessionTodosSnapshotEntry extends BaseSessionLogEntry {
  type: "todos_snapshot";
  todos: Todo[];
}

export type SessionLogEntry =
  | SessionMetadataEntry
  | SessionSummaryEntry
  | SessionMarkerEntry
  | SessionUserMessageEntry
  | SessionAssistantMessageEntry
  | SessionToolCallEntry
  | SessionToolResultEntry
  | SessionTodosSnapshotEntry;

export interface LegacySessionEntry {
  id: string;
  type: "metadata" | "message" | "compaction";
  data?: Message;
  summary?: string;
  metadata?: SessionMetadata;
  timestamp: number;
}

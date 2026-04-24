/**
 * Core types for the coding agent.
 */

// ============================================================================
// Messages
// ============================================================================

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextContent | ImageContent;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningEffort = ThinkingLevel;

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
  /**
   * Marks this message as harness-emitted metadata (e.g. a <system-reminder>),
   * not actual user input. Renderers may hide these; compaction should generally preserve them.
   */
  isMeta?: boolean;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage | SystemMessage;

// ============================================================================
// Tools
// ============================================================================

export interface ToolParameter {
  type?: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, ToolParameter>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string
}

export interface ParsedToolCall extends ToolCall {
  parsedArgs: Record<string, any>;
}

export type ToolResultStatus =
  | "success"
  | "no_match"
  | "partial"
  | "timeout"
  | "blocked"
  | "command_error";

export interface ToolResultMetadata {
  kind?: "search" | "read" | "write" | "edit" | "shell" | "web" | "security";
  path?: string;
  pattern?: string;
  matches?: number;
  truncated?: boolean;
  searchSignature?: string;
  searchFamily?: string;
  reason?: string;
  arbiterNote?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  status?: ToolResultStatus;
  metadata?: ToolResultMetadata;
}

export type ToolExecutor = (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  agent?: {
    runSubtask: (
      input: string | ContentPart[],
      cwd: string,
      options?: { subtaskType?: string; description?: string },
    ) => Promise<ToolResult>;
  };
}

export interface ToolRegistryEntry extends ToolDefinition {
  execute: ToolExecutor;
  /** Whether this tool is allowed in plan mode. Defaults to false (treated as write-capable). */
  readOnly?: boolean;
  /**
   * If true, this tool is omitted from the tool list sent to the model on each
   * turn until unlocked via `tool_search`. Only the tool's name appears in a
   * startup &lt;system-reminder&gt;. Used for MCP tools to keep them out of the
   * per-turn context cost when not in use.
   */
  deferred?: boolean;
}

// ============================================================================
// Permission mode
// ============================================================================

/**
 * Runtime permission policy for tool execution. Mirrors Claude Code's
 * `EXTERNAL_PERMISSION_MODES`:
 *
 * - `default`         — every destructive tool asks via the approval UI.
 * - `acceptEdits`     — edits/writes auto-approve; bash still asks.
 * - `plan`            — read-only tools only; the model must propose via
 *                       exit_plan_mode and get user approval before executing.
 * - `bypassPermissions` — everything auto-approves. Must be explicitly enabled
 *                       via --dangerously-skip-permissions at startup.
 * - `dontAsk`         — same as bypass but silent (no prompts, no extra
 *                       narration). Not in the Shift+Tab cycle.
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

export type PlanDecision =
  | { action: "approve"; plan: string }
  | { action: "reject"; reason?: string };

// ============================================================================
// Todos
// ============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

// ============================================================================
// Provider
// ============================================================================

export type StreamChunk =
  | { type: "text"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: string; isStart: boolean; isEnd: boolean }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done" };

export interface Provider {
  streamChat(
    messages: Message[],
    options: {
      model: string;
      tools?: ToolDefinition[];
      temperature?: number;
      thinkingLevel?: ThinkingLevel;
    }
  ): AsyncIterable<StreamChunk>;
  complete(messages: Message[], options?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel }): Promise<string>;
}

// ============================================================================
// Agent Events
// ============================================================================

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, any> }
  | { type: "tool_end"; id: string; name: string; result: ToolResult }
  | { type: "turn_end"; usage?: { promptTokens: number; completionTokens: number } }
  | { type: "context_recovered"; droppedMessages: number; reason: "overflow" }
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "todos_updated"; todos: Todo[] }
  | { type: "agent_end" };

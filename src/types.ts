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
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  /** Model metadata captured for local usage statistics. */
  model?: string;
  providerId?: string;
  modelId?: string;
  usage?: TokenUsage;
  error?: {
    name: string;
    message: string;
    aborted?: boolean;
  };
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  content: string;
  metadata?: ToolResultMetadata;
  isError?: boolean;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export type MetaMessageKind = "system-reminder" | "runtime-context";

export interface MetaMessage {
  role: "meta";
  kind: MetaMessageKind;
  content: string;
  /**
   * Runtime metadata is hidden from transcript and session persistence. When
   * true or omitted, the projector may convert it into model context.
   */
  includeInLlm?: boolean;
}

export type ProviderMessage = UserMessage | AssistantMessage | ToolMessage | SystemMessage;
export type Message = ProviderMessage | MetaMessage;

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
  /**
   * Provider-side flag set when the streamed arguments were unsalvageable
   * (truncated mid-JSON, malformed snapshot). Persists into history so the
   * model and the orchestrator can both see the call was rejected upstream
   * rather than executed silently with empty args.
   */
  argsCorrupt?: boolean;
}

export interface ParsedToolCall extends ToolCall {
  parsedArgs: Record<string, any>;
  /**
   * Set when the raw `arguments` string failed to JSON.parse, indicating
   * upstream streaming corruption (truncated chunks, malformed deltas, etc.).
   * Consumers should refuse to execute the tool and surface a tool_use_error
   * so the model can re-issue the call.
   */
  argsCorrupt?: boolean;
}

export type ToolResultStatus =
  | "success"
  | "no_match"
  | "partial"
  | "timeout"
  | "blocked"
  | "cancelled"
  | "command_error";

export interface ToolResultMetadata {
  kind?: "search" | "read" | "write" | "edit" | "patch" | "shell" | "server" | "web" | "security" | "lsp" | "question" | "subagent";
  path?: string;
  pattern?: string;
  matches?: number;
  truncated?: boolean;
  searchSignature?: string;
  searchFamily?: string;
  reason?: string;
  arbiterNote?: string;
  diff?: string;
  addedLines?: number;
  removedLines?: number;
  [key: string]: unknown;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  status?: ToolResultStatus;
  metadata?: ToolResultMetadata;
}

export type ToolEffect = "read" | "write_patch" | "write_direct" | "unknown";

export interface ToolUpdate {
  type: "subagent_update";
  parentToolCallId: string;
  runId: string;
  subAgentId: string;
  agentName: string;
  nickname?: string;
  category?: string;
  route?: import("./agent/categories.js").ResolvedSubagentRoute;
  status: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
  childEvent?: AgentEvent;
  summaryDelta?: string;
  toolName?: string;
  toolCallId?: string;
  message?: string;
  metadata?: ToolResultMetadata;
}

export type ToolExecutor = (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolContext {
  cwd: string;
  sessionID?: string;
  abortSignal?: AbortSignal;
  toolCall?: {
    id: string;
    name: string;
  };
  agent?: {
    runSubtask: (
      input: string | ContentPart[],
      cwd: string,
      options?: { subtaskType?: string; description?: string },
    ) => Promise<ToolResult>;
    runSubAgent?: (
      input: string | ContentPart[],
      cwd: string,
      options: {
        profile: import("./agent/profiles.js").AgentProfile;
        runId: string;
        subAgentId: string;
        parentToolCallId: string;
        category?: string;
        route?: import("./agent/categories.js").ResolvedSubagentRoute;
        approval?: "fail" | "disabled";
        emitUpdate?: (update: ToolUpdate) => void;
        description?: string;
        abortSignal?: AbortSignal;
        nickname?: string;
        forkContext?: boolean;
      },
    ) => Promise<import("./agent/profiles.js").SubagentRunResult>;
    spawnSubAgent?: (
      input: string | ContentPart[],
      cwd: string,
      options: {
        profile: import("./agent/profiles.js").AgentProfile;
        parentToolCallId: string;
        category?: string;
        route?: import("./agent/categories.js").ResolvedSubagentRoute;
        approval?: "fail" | "disabled";
        description?: string;
        abortSignal?: AbortSignal;
        forkContext?: boolean;
      },
    ) => Promise<import("./agent/subagent-control.js").SubagentThreadSnapshot>;
    waitSubAgents?: (
      options: {
        agentIds?: string[];
        timeoutMs?: number;
      },
    ) => Promise<import("./agent/subagent-control.js").SubagentThreadSnapshot[]>;
    sendSubAgentInput?: (
      agentId: string,
      input: string | ContentPart[],
      cwd: string,
      options?: {
        interrupt?: boolean;
        parentToolCallId?: string;
        abortSignal?: AbortSignal;
      },
    ) => Promise<import("./agent/subagent-control.js").SubagentThreadSnapshot>;
    closeSubAgent?: (agentId: string) => Promise<import("./agent/subagent-control.js").SubagentThreadSnapshot>;
    listSubAgents?: () => import("./agent/subagent-control.js").SubagentThreadSnapshot[];
  };
  emitUpdate?: (update: ToolUpdate) => void;
}

export interface ToolRegistryEntry extends ToolDefinition {
  execute: ToolExecutor;
  /** Whether this tool is allowed in plan mode. Defaults to false (treated as write-capable). */
  readOnly?: boolean;
  /** Capability classification used by subagent profiles. Defaults to "unknown". */
  effect?: ToolEffect;
  /** True when the tool may call ApprovalController.request(...) for an interactive decision. */
  requiresApproval?: boolean;
  /**
   * If true, this tool is omitted from the tool list sent to the model on each
   * turn until unlocked via `tool_search`. Only the tool's name appears in a
   * startup runtime reminder. Used for MCP tools to keep them out of the
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
 * - `default`         — normal Build mode: edits/writes auto-approve; bash
 *                       and other destructive tools ask unless allowed by rules.
 * - `plan`            — read-only tools only; the model must propose via
 *                       exit_plan_mode and get user approval before executing.
 * - `bypassPermissions` — everything auto-approves. Must be explicitly enabled
 *                       via --dangerously-skip-permissions at startup.
 */
export type PermissionMode =
  | "default"
  | "plan"
  | "bypassPermissions";

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
  | { type: "tool_call"; id: string; name: string; arguments: string; isStart: boolean; isEnd: boolean; argumentsFull?: string; argumentsCorrupt?: boolean }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface Provider {
  streamChat(
    messages: ProviderMessage[],
    options: {
      model: string;
      tools?: ToolDefinition[];
      temperature?: number;
      thinkingLevel?: ThinkingLevel;
      abortSignal?: AbortSignal;
    }
  ): AsyncIterable<StreamChunk>;
  complete(messages: ProviderMessage[], options?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal }): Promise<string>;
}

export interface AgentRunInput {
  id: string;
  content: string;
  submittedAt?: number;
}

export interface AgentInputController {
  drainPendingInputs(): AgentRunInput[];
  pendingInputCount(): number;
}

export type AgentInputRejectedReason = "no_continuation";

// ============================================================================
// Agent Events
// ============================================================================

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; name: string; argumentsDelta: string; arguments: string }
  | { type: "tool_call_end"; id: string; name: string; arguments: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, any> }
  | { type: "tool_update"; id: string; name: string; update: ToolUpdate }
  | { type: "tool_end"; id: string; name: string; result: ToolResult }
  | { type: "turn_end"; usage?: TokenUsage; willContinue?: boolean }
  | { type: "context_recovered"; droppedMessages: number; reason: "overflow" }
  | { type: "input_pending_changed"; pending: number }
  | { type: "input_applied"; id: string; content: string; target: "current_turn" }
  | { type: "input_rejected"; id: string; content: string; reason: AgentInputRejectedReason; target: "next_turn" }
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "todos_updated"; todos: Todo[] }
  | { type: "agent_end" };

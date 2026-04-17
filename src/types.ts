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
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export type ToolExecutor = (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

export interface ToolRegistryEntry extends ToolDefinition {
  execute: ToolExecutor;
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
  | { type: "agent_end" };

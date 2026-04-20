/**
 * MCP (Model Context Protocol) core types.
 *
 * Server configurations loaded from settings.json:
 *
 *   "mcpServers": {
 *     "github": { "type": "stdio", "command": "npx", "args": ["-y", "..."], "env": {...} },
 *     "exa":    { "type": "http",  "url": "https://mcp.exa.ai/mcp", "headers": {...} },
 *     "acme":   { "type": "sse",   "url": "https://acme.example/mcp/sse" }
 *   }
 *
 * Shape mirrors Claude Desktop / Claude Code (minus OAuth, ws, sdk — not in v1).
 */

import type { ToolSchema } from "../types.js";

export type McpTransportType = "stdio" | "http" | "sse";

export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface SseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig | SseServerConfig;

/** A server config annotated with its source scope and original (unnormalized) name. */
export interface ScopedMcpServerConfig {
  name: string;
  scope: "user" | "project" | "local";
  config: McpServerConfig;
}

/** One tool exposed by an MCP server, as returned by `tools/list`. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** One prompt exposed by an MCP server, as returned by `prompts/list`. */
export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Status of a single server connection. */
export type McpServerStatus =
  | {
      kind: "connected";
      tools: McpToolInfo[];
      prompts: McpPromptInfo[];
      serverInfo?: { name: string; version: string };
    }
  | { kind: "failed"; error: string }
  | { kind: "disabled" };

export interface McpServerState {
  name: string;
  scope: "user" | "project" | "local";
  config: McpServerConfig;
  status: McpServerStatus;
}

/** A JSON-RPC message. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Low-level transport interface. */
export interface McpTransport {
  start(): Promise<void>;
  send(message: JsonRpcRequest | JsonRpcNotification): Promise<void>;
  /** Called once per incoming JSON-RPC message (response or server→client request/notification). */
  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest) => void): void;
  onError(handler: (err: Error) => void): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

/** Shape we convert MCP `inputSchema` into for the agent's ToolDefinition. */
export type McpToolParameters = ToolSchema;

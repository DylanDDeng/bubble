/**
 * MCPClient — protocol layer over a transport.
 *
 * Handles JSON-RPC id correlation, the `initialize` handshake, and typed
 * wrappers for `tools/list` / `tools/call`. Enough surface for the tool
 * registry to plug MCP tools in; more methods can be added the same way.
 */

import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpPromptInfo,
  McpToolInfo,
  McpTransport,
} from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ClientInfo {
  name: string;
  version: string;
}

export interface ToolCallContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [extra: string]: unknown;
}

export interface ToolCallResult {
  content: ToolCallContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** One block from a prompt message. MCP content types mirror tools. */
export interface PromptContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [extra: string]: unknown;
}

export interface PromptMessage {
  role: "user" | "assistant";
  /** Per MCP spec `content` is a single block; some servers return an array. */
  content: PromptContentBlock | PromptContentBlock[];
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class MCPClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private _serverInfo?: { name: string; version: string };
  private _capabilities?: Record<string, unknown>;
  private _instructions?: string;

  constructor(
    private readonly transport: McpTransport,
    private readonly clientInfo: ClientInfo,
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    transport.onMessage((msg) => this.onMessage(msg));
    transport.onError((err) => {
      // Fail all outstanding calls; the manager will surface this.
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    });
    transport.onClose(() => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("MCP transport closed"));
      }
      this.pending.clear();
    });
  }

  async start(): Promise<void> {
    await this.transport.start();
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const result = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    })) as {
      serverInfo?: { name: string; version: string };
      capabilities?: Record<string, unknown>;
      instructions?: string;
    };

    this._serverInfo = result.serverInfo;
    this._capabilities = result.capabilities;
    this._instructions = result.instructions;

    // Per spec, client must send `notifications/initialized` after the response.
    await this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    } satisfies JsonRpcNotification);
  }

  get serverInfo(): { name: string; version: string } | undefined {
    return this._serverInfo;
  }

  get capabilities(): Record<string, unknown> | undefined {
    return this._capabilities;
  }

  get instructions(): string | undefined {
    return this._instructions;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
        nextCursor?: string;
      };
      if (Array.isArray(result.tools)) {
        for (const t of result.tools) {
          tools.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
      }
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    const prompts: McpPromptInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request("prompts/list", cursor ? { cursor } : {})) as {
        prompts?: Array<{
          name: string;
          description?: string;
          arguments?: Array<{ name: string; description?: string; required?: boolean }>;
        }>;
        nextCursor?: string;
      };
      if (Array.isArray(result.prompts)) {
        for (const p of result.prompts) {
          prompts.push({
            name: p.name,
            description: p.description,
            arguments: p.arguments,
          });
        }
      }
      cursor = result.nextCursor;
    } while (cursor);
    return prompts;
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    timeoutMs?: number,
  ): Promise<PromptResult> {
    const result = (await this.request(
      "prompts/get",
      { name, arguments: args },
      timeoutMs,
    )) as PromptResult;
    return {
      description: result.description,
      messages: Array.isArray(result.messages) ? result.messages : [],
    };
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolCallResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as ToolCallResult;
    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: result.isError,
      structuredContent: result.structuredContent,
    };
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP client is closed"));
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const ms = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(req).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private onMessage(msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest): void {
    // Response: has "id" plus "result" or "error".
    if ("id" in msg && (("result" in msg) || ("error" in msg))) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in msg && msg.error) {
        pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      } else {
        pending.resolve((msg as JsonRpcResponse).result);
      }
      return;
    }
    // Server→client request or notification. v1 ignores these (no sampling, no roots).
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.transport.close();
  }
}

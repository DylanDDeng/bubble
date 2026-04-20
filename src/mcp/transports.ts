/**
 * MCP transports — minimal, dependency-free JSON-RPC clients.
 *
 * Two transports in v1:
 *   - StdioTransport: child process, line-delimited JSON on stdin/stdout
 *   - HttpTransport: POST JSON-RPC over HTTP (Streamable HTTP), handle both
 *     application/json and text/event-stream responses. Also used for `sse`
 *     servers — the spec lets a server respond with either content-type.
 *
 * These deliberately do NOT depend on @modelcontextprotocol/sdk. The SDK pulls
 * in zod + schema machinery we don't need. Our surface area here is small:
 * initialize + tools/list + tools/call. Adding more methods is just more
 * JSON-RPC calls on the same pipe.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  HttpServerConfig,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
  SseServerConfig,
  StdioServerConfig,
} from "./types.js";

type IncomingHandler = (msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest) => void;

// ---------------------------------------------------------------------------
// Stdio
// ---------------------------------------------------------------------------

export class StdioTransport implements McpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderrBuffer = "";
  private messageHandler?: IncomingHandler;
  private errorHandler?: (err: Error) => void;
  private closeHandler?: () => void;
  private closed = false;

  constructor(private readonly config: StdioServerConfig) {}

  async start(): Promise<void> {
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...(this.config.env ?? {}) };
    const child = spawn(this.config.command, this.config.args ?? [], {
      env,
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 8192) {
        this.stderrBuffer = this.stderrBuffer.slice(-4096);
      }
    });

    child.on("error", (err) => {
      this.errorHandler?.(err);
    });

    child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      if (code && code !== 0) {
        const msg = `stdio server exited with code ${code}${signal ? ` (signal ${signal})` : ""}${this.stderrBuffer ? `\nstderr:\n${this.stderrBuffer.trim()}` : ""}`;
        this.errorHandler?.(new Error(msg));
      }
      this.closeHandler?.();
    });
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        this.messageHandler?.(parsed);
      } catch {
        // Ignore non-JSON log lines from the server process.
      }
    }
  }

  async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this.child || this.closed) throw new Error("Transport not started or already closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  onMessage(handler: IncomingHandler): void {
    this.messageHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      // Give it 500ms before SIGKILL.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 500).unref?.();
    }
  }

  getStderr(): string {
    return this.stderrBuffer;
  }
}

// ---------------------------------------------------------------------------
// HTTP (Streamable HTTP) — also handles `sse` servers since the spec overlaps.
// ---------------------------------------------------------------------------

export class HttpTransport implements McpTransport {
  private messageHandler?: IncomingHandler;
  private errorHandler?: (err: Error) => void;
  private closeHandler?: () => void;
  private sessionId?: string;
  private closed = false;
  private readonly url: string;
  private readonly baseHeaders: Record<string, string>;

  constructor(config: HttpServerConfig | SseServerConfig) {
    this.url = config.url;
    this.baseHeaders = { ...(config.headers ?? {}) };
  }

  async start(): Promise<void> {
    // HTTP transport is connectionless per message. Nothing to do here.
  }

  async send(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (this.closed) throw new Error("Transport closed");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.baseHeaders,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorHandler?.(error);
      throw error;
    }

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) this.sessionId = newSessionId;

    // Notifications or responses that return 202 Accepted with no body.
    if (response.status === 202 || response.status === 204) {
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const err = new Error(`HTTP ${response.status} from MCP server${body ? `: ${body.slice(0, 500)}` : ""}`);
      this.errorHandler?.(err);
      throw err;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();

    if (contentType.includes("text/event-stream")) {
      this.parseSseBody(text);
      return;
    }

    // application/json — single JSON-RPC response, or a JSON array of them.
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) this.messageHandler?.(item);
      } else {
        this.messageHandler?.(parsed);
      }
    } catch {
      // Fall back to SSE parsing — some servers send SSE without the content-type.
      this.parseSseBody(text);
    }
  }

  private parseSseBody(body: string): void {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        this.messageHandler?.(parsed);
      } catch {
        // skip malformed SSE data line
      }
    }
  }

  onMessage(handler: IncomingHandler): void {
    this.messageHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Best-effort session termination. Per spec, DELETE /mcp with the session id.
    if (this.sessionId) {
      try {
        await fetch(this.url, {
          method: "DELETE",
          headers: { "Mcp-Session-Id": this.sessionId, ...this.baseHeaders },
        });
      } catch {
        // ignore
      }
    }
    this.closeHandler?.();
  }
}

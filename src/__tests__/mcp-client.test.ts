import { describe, expect, it } from "vitest";
import { MCPClient } from "../mcp/client.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from "../mcp/types.js";

/**
 * In-memory transport that simulates an MCP server by responding synchronously
 * to initialize / tools/list / tools/call. Lets us unit-test the client's id
 * correlation and protocol flow without spawning a process.
 */
class FakeTransport implements McpTransport {
  private messageHandler?: (m: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest) => void;
  private errorHandler?: (e: Error) => void;
  private closeHandler?: () => void;
  sent: (JsonRpcRequest | JsonRpcNotification)[] = [];
  closed = false;

  constructor(
    private readonly respond: (req: JsonRpcRequest) => Partial<JsonRpcResponse> | undefined,
  ) {}

  async start(): Promise<void> {}

  async send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    this.sent.push(msg);
    if ("id" in msg) {
      // Respond asynchronously so id registration completes first.
      queueMicrotask(() => {
        const reply = this.respond(msg);
        if (!reply) return;
        const full: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id,
          ...reply,
        };
        this.messageHandler?.(full);
      });
    }
  }

  onMessage(handler: (m: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (e: Error) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeHandler?.();
  }

  emitError(err: Error) {
    this.errorHandler?.(err);
  }
}

describe("MCPClient", () => {
  it("performs initialize handshake, lists tools, calls tool", async () => {
    const transport = new FakeTransport((req) => {
      if (req.method === "initialize") {
        return {
          result: {
            serverInfo: { name: "fake", version: "1.0.0" },
            capabilities: { tools: {} },
            protocolVersion: "2025-06-18",
          },
        };
      }
      if (req.method === "tools/list") {
        return {
          result: {
            tools: [
              {
                name: "echo",
                description: "Echoes input",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          },
        };
      }
      if (req.method === "tools/call") {
        const params = req.params as { name: string; arguments: { text: string } };
        return {
          result: {
            content: [{ type: "text", text: `echoed: ${params.arguments.text}` }],
          },
        };
      }
      return undefined;
    });

    const client = new MCPClient(transport, { name: "test", version: "0.0.0" }, 2000);
    await client.start();

    expect(client.serverInfo).toEqual({ name: "fake", version: "1.0.0" });
    // After initialize, the client must send notifications/initialized.
    expect(transport.sent.some((m) => m.method === "notifications/initialized")).toBe(true);

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("echo");

    const result = await client.callTool("echo", { text: "hi" });
    expect(result.content[0]).toEqual({ type: "text", text: "echoed: hi" });
    expect(result.isError).toBeUndefined();

    await client.close();
    expect(transport.closed).toBe(true);
  });

  it("rejects outstanding requests when transport errors", async () => {
    const transport = new FakeTransport(() => undefined); // never responds
    const client = new MCPClient(transport, { name: "t", version: "0" }, 5000);
    // start() awaits initialize — we need to race it.
    const startPromise = client.start();
    // Wait a tick for the request to be sent, then emit an error.
    await new Promise((r) => setTimeout(r, 10));
    transport.emitError(new Error("boom"));
    await expect(startPromise).rejects.toThrow(/boom/);
  });

  it("lists prompts and fetches prompt content", async () => {
    const transport = new FakeTransport((req) => {
      if (req.method === "initialize") {
        return { result: { serverInfo: { name: "fake", version: "1" } } };
      }
      if (req.method === "prompts/list") {
        return {
          result: {
            prompts: [
              {
                name: "greet",
                description: "Say hi",
                arguments: [{ name: "person", required: true }],
              },
            ],
          },
        };
      }
      if (req.method === "prompts/get") {
        const params = req.params as { name: string; arguments: { person: string } };
        return {
          result: {
            messages: [
              { role: "user", content: { type: "text", text: `Hi ${params.arguments.person}` } },
            ],
          },
        };
      }
      return undefined;
    });

    const client = new MCPClient(transport, { name: "t", version: "0" });
    await client.start();

    const prompts = await client.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("greet");

    const result = await client.getPrompt("greet", { person: "Ada" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const c = result.messages[0].content;
    const text = Array.isArray(c) ? (c[0] as any).text : (c as any).text;
    expect(text).toBe("Hi Ada");
  });

  it("surfaces JSON-RPC error responses", async () => {
    const transport = new FakeTransport((req) => {
      if (req.method === "initialize") {
        return { result: { serverInfo: { name: "fake", version: "1.0.0" } } };
      }
      if (req.method === "tools/list") {
        return { error: { code: -32601, message: "Method not found" } };
      }
      return undefined;
    });
    const client = new MCPClient(transport, { name: "t", version: "0" });
    await client.start();
    await expect(client.listTools()).rejects.toThrow(/Method not found/);
  });
});

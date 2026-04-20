/**
 * MCPConnectionManager — brings up all configured servers in parallel,
 * discovers their tools, and exposes ToolRegistryEntry[] for the agent.
 *
 * One failed server never blocks the others. Failures are captured in
 * per-server state so /mcp can surface them to the user without taking the
 * agent down.
 */

import type { ToolRegistryEntry, ToolResult, ToolSchema } from "../types.js";
import type { SlashCommand } from "../slash-commands/types.js";
import { MCPClient, type PromptContentBlock, type PromptMessage } from "./client.js";
import { HttpTransport, StdioTransport } from "./transports.js";
import { buildMcpToolName } from "./name.js";
import type {
  McpPromptInfo,
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  ScopedMcpServerConfig,
} from "./types.js";

export interface McpManagerOptions {
  servers: ScopedMcpServerConfig[];
  clientInfo?: { name: string; version: string };
  /** Log callback for non-fatal issues. Defaults to stderr. */
  onDiagnostic?: (message: string) => void;
}

interface Connection {
  state: McpServerState;
  client?: MCPClient;
}

export class McpManager {
  private connections = new Map<string, Connection>();
  private readonly clientInfo: { name: string; version: string };
  private readonly onDiagnostic: (msg: string) => void;

  constructor(private readonly options: McpManagerOptions) {
    this.clientInfo = options.clientInfo ?? { name: "bubble", version: "0.1.0" };
    this.onDiagnostic = options.onDiagnostic ?? ((msg) => console.error(msg));
    for (const server of options.servers) {
      this.connections.set(server.name, {
        state: { name: server.name, scope: server.scope, config: server.config, status: { kind: "disabled" } },
      });
    }
  }

  /** Connect all configured servers. Never throws — per-server errors are captured in state. */
  async start(): Promise<void> {
    await Promise.all(
      this.options.servers.map(async (server) => {
        await this.connectOne(server);
      }),
    );
  }

  private async connectOne(server: ScopedMcpServerConfig): Promise<void> {
    const existing = this.connections.get(server.name)!;
    try {
      const client = await createClient(server.config, this.clientInfo);
      const tools = await client.listTools();
      const prompts = client.capabilities?.prompts
        ? await client.listPrompts().catch((err) => {
            this.onDiagnostic(`[mcp:${server.name}] prompts/list failed: ${(err as Error).message}`);
            return [] as McpPromptInfo[];
          })
        : [];
      existing.client = client;
      existing.state = {
        name: server.name,
        scope: server.scope,
        config: server.config,
        status: { kind: "connected", tools, prompts, serverInfo: client.serverInfo },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      existing.state = {
        name: server.name,
        scope: server.scope,
        config: server.config,
        status: { kind: "failed", error: message },
      };
      this.onDiagnostic(`[mcp:${server.name}] failed to connect: ${message}`);
    }
  }

  /** Disconnect and reconnect a single server. Returns the new state. */
  async reconnect(name: string): Promise<McpServerState | null> {
    const conn = this.connections.get(name);
    if (!conn) return null;
    if (conn.client) {
      try {
        await conn.client.close();
      } catch {
        // ignore
      }
      conn.client = undefined;
    }
    const server: ScopedMcpServerConfig = {
      name: conn.state.name,
      scope: conn.state.scope,
      config: conn.state.config,
    };
    await this.connectOne(server);
    return conn.state;
  }

  /** Shutdown all connections. Best-effort; errors are ignored. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map(async (conn) => {
        if (!conn.client) return;
        try {
          await conn.client.close();
        } catch {
          // ignore
        }
        conn.client = undefined;
      }),
    );
  }

  getStates(): McpServerState[] {
    return [...this.connections.values()].map((c) => c.state);
  }

  /** Produce ToolRegistryEntry[] for every tool from every connected server. */
  getToolEntries(): ToolRegistryEntry[] {
    const entries: ToolRegistryEntry[] = [];
    for (const conn of this.connections.values()) {
      if (conn.state.status.kind !== "connected" || !conn.client) continue;
      const serverName = conn.state.name;
      for (const tool of conn.state.status.tools) {
        entries.push(buildToolEntry(serverName, tool, () => conn.client));
      }
    }
    return entries;
  }

  /**
   * Produce SlashCommand[] for every prompt from every connected server.
   * Each command, when invoked, calls `prompts/get` with positionally-parsed
   * arguments and returns an `inject` payload that the harness hands back to
   * the agent as the user's next turn.
   */
  getPromptCommands(): SlashCommand[] {
    const commands: SlashCommand[] = [];
    for (const conn of this.connections.values()) {
      if (conn.state.status.kind !== "connected" || !conn.client) continue;
      const serverName = conn.state.name;
      for (const prompt of conn.state.status.prompts) {
        commands.push(buildPromptCommand(serverName, prompt, () => conn.client));
      }
    }
    return commands;
  }
}

async function createClient(
  config: McpServerConfig,
  clientInfo: { name: string; version: string },
): Promise<MCPClient> {
  const transport = config.type === "stdio" ? new StdioTransport(config) : new HttpTransport(config);
  const client = new MCPClient(transport, clientInfo);
  await client.start();
  return client;
}

function buildToolEntry(
  serverName: string,
  tool: McpToolInfo,
  getClient: () => MCPClient | undefined,
): ToolRegistryEntry {
  const name = buildMcpToolName(serverName, tool.name);
  const parameters = coerceSchema(tool.inputSchema);
  const descriptionPrefix = `[MCP:${serverName}]`;
  const description = [descriptionPrefix, tool.description?.trim() || tool.name].filter(Boolean).join(" ");

  return {
    name,
    description,
    parameters,
    readOnly: false, // Conservative default; user can allow-list.
    deferred: true, // Load schema on demand via tool_search to keep context small.
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const client = getClient();
      if (!client) {
        return {
          content: `Error: MCP server "${serverName}" is not connected.`,
          isError: true,
        };
      }
      try {
        const result = await client.callTool(tool.name, args);
        const text = formatToolContent(result.content);
        return { content: text || "(no content)", isError: result.isError === true };
      } catch (err) {
        return {
          content: `Error calling ${serverName}.${tool.name}: ${(err as Error).message || String(err)}`,
          isError: true,
        };
      }
    },
  };
}

function coerceSchema(input: unknown): ToolSchema {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const s = input as Record<string, unknown>;
    if (s.type === "object" && typeof s.properties === "object") {
      return input as ToolSchema;
    }
  }
  // Fallback — some servers omit inputSchema or send something odd.
  return { type: "object", properties: {} };
}

function buildPromptCommand(
  serverName: string,
  prompt: McpPromptInfo,
  getClient: () => MCPClient | undefined,
): SlashCommand {
  const name = buildMcpToolName(serverName, prompt.name);
  const argNames = (prompt.arguments ?? []).map((a) => a.name);
  const argSig = argNames.length > 0 ? ` <${argNames.join("> <")}>` : "";
  const description = `[MCP:${serverName}] ${prompt.description?.trim() || prompt.name}${argSig ? ` (args:${argSig})` : ""}`;

  return {
    name,
    description,
    async handler(args: string) {
      const client = getClient();
      if (!client) {
        return `Error: MCP server "${serverName}" is not connected.`;
      }

      const values = parsePositionalArgs(args);
      const mapped: Record<string, string> = {};
      for (let i = 0; i < argNames.length; i++) {
        mapped[argNames[i]] = values[i] ?? "";
      }
      const required = (prompt.arguments ?? []).filter((a) => a.required).map((a) => a.name);
      const missing = required.filter((n) => !mapped[n]);
      if (missing.length > 0) {
        return `Error: /${name} is missing required arg${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`;
      }

      try {
        const result = await client.getPrompt(prompt.name, mapped);
        const text = flattenPromptMessages(result.messages);
        if (!text.trim()) {
          return `Error: /${name} returned an empty prompt.`;
        }
        return { inject: text };
      } catch (err) {
        return `Error calling ${serverName}.${prompt.name}: ${(err as Error).message || String(err)}`;
      }
    },
  };
}

/**
 * Split positional args on whitespace, honoring double-quoted phrases so an
 * argument like `"attention is all you need"` stays intact. Backslash escaping
 * is not supported — keeps v1 predictable.
 */
function parsePositionalArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/**
 * Collapse `prompts/get` messages into a single user-input string for the
 * agent. Text from every message is concatenated; non-text blocks are
 * annotated. Role labels are preserved only when the prompt mixes roles, so
 * simple single-user-message prompts pass through cleanly.
 */
function flattenPromptMessages(messages: PromptMessage[]): string {
  const allUser = messages.every((m) => m.role === "user");
  const parts: string[] = [];
  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    const text = blocks.map(promptBlockToText).filter(Boolean).join("\n");
    if (!text) continue;
    parts.push(allUser ? text : `[${msg.role}]\n${text}`);
  }
  return parts.join("\n\n");
}

function promptBlockToText(block: PromptContentBlock): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource") return `[resource: ${block.mimeType ?? "unknown"}]`;
  if (block.type === "image") return `[image: ${block.mimeType ?? "unknown"}]`;
  return `[${block.type}]`;
}

function formatToolContent(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image" && item.mimeType) {
      parts.push(`[image: ${item.mimeType}, ${(item.data?.length ?? 0)} bytes base64]`);
    } else if (item.type === "resource") {
      parts.push(`[resource: ${item.mimeType ?? "unknown"}]`);
    } else {
      parts.push(`[${item.type}]`);
    }
  }
  return parts.join("\n");
}

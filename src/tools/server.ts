/**
 * Managed development server tools.
 */

import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import {
  getManagedServer,
  getManagedServerLogs,
  listManagedServers,
  startManagedServer,
  stopManagedServer,
  type ManagedServerInfo,
  type ManagedServerLifecycle,
  type ManagedServerPurpose,
} from "./server-manager.js";

export function createManagedServerTools(cwd: string, approval?: ApprovalController): ToolRegistryEntry[] {
  return [
    {
      name: "start_server",
      deferred: true,
      effect: "unknown",
      requiresApproval: true,
      description:
        "Start a long-running development server as a managed service. Use this instead of bash for npm run dev, next dev, vite, webpack --watch, or similar commands. Pass a foreground server command without a trailing '&'. The tool waits for readiness and then returns a server_id; use server_status, server_logs, and stop_server to manage it.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Foreground server command to run, for example npm run dev" },
          port: { type: "number", description: "Expected localhost port, used for readiness checks and conflict detection" },
          readinessUrl: { type: "string", description: "URL to poll until the server is ready. Defaults to http://localhost:<port> when port is provided." },
          timeout: { type: "number", description: "Seconds to wait for readiness. Defaults to 30." },
          purpose: { type: "string", enum: ["preview", "verification"], description: "Why the server is being started." },
          lifecycle: { type: "string", enum: ["auto", "keep_alive"], description: "auto stops at the end of the agent run; keep_alive remains available until stop_server or process exit." },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(args, ctx): Promise<ToolResult> {
        const command = String(args.command ?? "").trim();
        if (!command) {
          return {
            content: "Error: command is required",
            isError: true,
            status: "blocked",
            metadata: { kind: "server", reason: "missing_command" },
          };
        }
        if (command.endsWith("&")) {
          return {
            content: "Error: start_server expects a foreground command. Remove the trailing '&' so Bubble can own the server lifecycle.",
            isError: true,
            status: "blocked",
            metadata: { kind: "server", reason: "background_command" },
          };
        }

        const gate = await gateToolAction(approval, { type: "bash", command, cwd });
        if (!gate.approved) return gate.result;

        const purpose = parsePurpose(args.purpose);
        const lifecycle = parseLifecycle(args.lifecycle, purpose);
        const timeoutSec = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : 30;

        try {
          const server = await startManagedServer({
            command,
            cwd: ctx.cwd || cwd,
            port: parsePort(args.port),
            readinessUrl: typeof args.readinessUrl === "string" && args.readinessUrl.trim()
              ? args.readinessUrl.trim()
              : undefined,
            timeoutSec,
            ownerSessionId: ctx.sessionID,
            ownerRunId: ctx.toolCall?.id,
            purpose,
            lifecycle,
          });
          return {
            content: formatServerStarted(server),
            status: "success",
            metadata: serverMetadata(server),
          };
        } catch (error: any) {
          return {
            content: `Error: ${error.message ?? String(error)}`,
            isError: true,
            status: "command_error",
            metadata: {
              kind: "server",
              reason: "start_failed",
              command,
              port: parsePort(args.port),
            },
          };
        }
      },
    },
    {
      name: "server_status",
      deferred: true,
      readOnly: true,
      effect: "read",
      description: "Show managed development server status. Pass serverId for one server, or omit it to list all managed servers.",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string", description: "Managed server id returned by start_server" },
        },
        additionalProperties: false,
      },
      async execute(args): Promise<ToolResult> {
        const serverId = typeof args.serverId === "string" ? args.serverId.trim() : "";
        if (serverId) {
          const server = getManagedServer(serverId);
          if (!server) return missingServer(serverId);
          return {
            content: formatServer(server),
            status: "success",
            metadata: serverMetadata(server),
          };
        }

        const servers = listManagedServers();
        if (servers.length === 0) {
          return {
            content: "No managed servers.",
            status: "no_match",
            metadata: { kind: "server", count: 0 },
          };
        }
        return {
          content: servers.map(formatServer).join("\n\n"),
          status: "success",
          metadata: { kind: "server", count: servers.length },
        };
      },
    },
    {
      name: "server_logs",
      deferred: true,
      readOnly: true,
      effect: "read",
      description: "Return recent logs for a managed development server.",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string", description: "Managed server id returned by start_server" },
          maxCharacters: { type: "number", description: "Maximum log characters to return. Defaults to 12000." },
        },
        required: ["serverId"],
        additionalProperties: false,
      },
      async execute(args): Promise<ToolResult> {
        const serverId = String(args.serverId ?? "").trim();
        if (!serverId) return missingServer(serverId);
        const maxChars = typeof args.maxCharacters === "number" && args.maxCharacters > 0
          ? Math.min(args.maxCharacters, 50000)
          : 12000;
        const logs = getManagedServerLogs(serverId, maxChars);
        if (logs === undefined) return missingServer(serverId);
        return {
          content: logs.trim() || "(no logs captured)",
          status: "success",
          metadata: { kind: "server", serverId, maxCharacters: maxChars },
        };
      },
    },
    {
      name: "stop_server",
      deferred: true,
      effect: "unknown",
      description: "Stop a managed development server by serverId.",
      parameters: {
        type: "object",
        properties: {
          serverId: { type: "string", description: "Managed server id returned by start_server" },
        },
        required: ["serverId"],
        additionalProperties: false,
      },
      async execute(args): Promise<ToolResult> {
        const serverId = String(args.serverId ?? "").trim();
        if (!serverId) return missingServer(serverId);
        const server = await stopManagedServer(serverId);
        if (!server) return missingServer(serverId);
        return {
          content: `Stopped ${server.id}.`,
          status: "success",
          metadata: serverMetadata(server),
        };
      },
    },
  ];
}

function parsePurpose(value: unknown): ManagedServerPurpose {
  return value === "verification" ? "verification" : "preview";
}

function parseLifecycle(value: unknown, purpose: ManagedServerPurpose): ManagedServerLifecycle {
  if (value === "auto" || value === "keep_alive") return value;
  return purpose === "verification" ? "auto" : "keep_alive";
}

function parsePort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 65535) {
    return undefined;
  }
  return value;
}

function formatServerStarted(server: ManagedServerInfo): string {
  const lines = [`Started ${server.id}.`];
  if (server.url) lines.push(`URL: ${server.url}`);
  if (server.port) lines.push(`Port: ${server.port}`);
  lines.push(`Status: ${server.status}`);
  lines.push(`Lifecycle: ${server.lifecycle}`);
  return lines.join("\n");
}

function formatServer(server: ManagedServerInfo): string {
  return [
    `${server.id}: ${server.status}`,
    `Command: ${server.command}`,
    `CWD: ${server.cwd}`,
    server.url ? `URL: ${server.url}` : undefined,
    server.port ? `Port: ${server.port}` : undefined,
    `Purpose: ${server.purpose}`,
    `Lifecycle: ${server.lifecycle}`,
    server.pid ? `PID: ${server.pid}` : undefined,
    server.exitCode !== undefined ? `Exit code: ${server.exitCode}` : undefined,
  ].filter(Boolean).join("\n");
}

function serverMetadata(server: ManagedServerInfo): ToolResult["metadata"] {
  return {
    kind: "server",
    serverId: server.id,
    status: server.status,
    command: server.command,
    cwd: server.cwd,
    port: server.port,
    url: server.url,
    purpose: server.purpose,
    lifecycle: server.lifecycle,
    pid: server.pid,
  };
}

function missingServer(serverId: string): ToolResult {
  return {
    content: serverId ? `Error: Managed server not found: ${serverId}` : "Error: serverId is required",
    isError: true,
    status: "no_match",
    metadata: {
      kind: "server",
      serverId,
      reason: "server_not_found",
    },
  };
}

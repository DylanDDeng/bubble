import type { AgentProfile, AgentProfileApproval, AgentProfileScope } from "../agent/profiles.js";
import { discoverAgentProfiles, findAgentProfile } from "../agent/profiles.js";
import type { SubagentThreadSnapshot } from "../agent/subagent-control.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

type LifecycleToolName = "spawn_agent" | "wait_agent" | "send_input" | "close_agent";

export function createSpawnAgentTool(): ToolRegistryEntry {
  return {
    name: "spawn_agent",
    readOnly: true,
    effect: "read",
    description: [
      "Start a child subagent in the background and return its agent_id plus random nickname.",
      "Use this for Codex-style delegation. The child has an independent thread; call wait_agent later to collect its result.",
      "When the user asks to use a subagent, spawn first with a clear task instead of doing the delegated investigation yourself.",
      "After spawning, do not duplicate the same delegated work locally; either wait for the child or do clearly non-overlapping work.",
      "agent_type defaults to default. Built-in types include default, explorer, and worker.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        agent_type: { type: "string", description: "Subagent profile or role name. Defaults to default." },
        agent: { type: "string", description: "Alias for agent_type." },
        message: { type: "string", description: "Initial task for the subagent." },
        task: { type: "string", description: "Alias for message." },
        fork_context: { type: "boolean", description: "When true, copy recent parent conversation into the child thread." },
        agentScope: {
          type: "string",
          enum: ["user", "project", "both"],
          description: "Which profile locations to load. Defaults to user profiles plus built-ins.",
        },
        allowProjectAgents: {
          type: "boolean",
          description: "Required to run profiles loaded from project-local .bubble/agents.",
        },
        approval: {
          type: "string",
          enum: ["fail", "disabled"],
          description: "How this child handles tools that need interactive approval.",
        },
      },
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.spawnSubAgent) {
        return toolRuntimeMissing("spawn_agent");
      }
      const message = stringArg(args.message) ?? stringArg(args.task);
      if (!message) {
        return { content: "Error: spawn_agent requires message or task.", isError: true };
      }
      const profileName = stringArg(args.agent_type) ?? stringArg(args.agent) ?? "default";
      const resolved = resolveProfile(ctx.cwd, profileName, parseScope(args.agentScope), args.allowProjectAgents === true);
      if ("error" in resolved) return resolved.error;
      if (resolved.profile.mode !== "readonly") {
        return unsupportedProfile(resolved.profile);
      }

      try {
        const snapshot = await ctx.agent.spawnSubAgent(message, ctx.cwd, {
          profile: resolved.profile,
          parentToolCallId: ctx.toolCall?.id ?? snapshotFallbackId(),
          approval: parseApproval(args.approval),
          abortSignal: ctx.abortSignal,
          forkContext: args.fork_context === true,
        });
        return formatLifecycleResult("spawn_agent", [snapshot], [
          `Spawned ${snapshot.nickname} (${snapshot.agentName})`,
          `agent_id: ${snapshot.agentId}`,
          `status: ${snapshot.status}`,
          `next: call wait_agent for ${snapshot.agentId} to collect the delegated result`,
        ]);
      } catch (error: any) {
        return toolError("spawn_agent", error);
      }
    },
  };
}

export function createWaitAgentTool(): ToolRegistryEntry {
  return {
    name: "wait_agent",
    readOnly: true,
    effect: "read",
    description: [
      "Wait for one or more spawned subagents to reach a final status and return snapshots.",
      "If the wait times out while children are still running, call wait_agent again with a longer timeout instead of redoing the same delegated work locally.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "A single agent id to wait for." },
        agent_ids: {
          type: "array",
          description: "Agent ids to wait for. If omitted, waits for any active subagent.",
          items: { type: "string" },
        },
        timeout_ms: { type: "number", description: "Maximum wait time in milliseconds. Defaults to 30000." },
      },
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.waitSubAgents) {
        return toolRuntimeMissing("wait_agent");
      }
      const agentIds = normalizeAgentIds(args.agent_ids, args.agent_id);
      try {
        const snapshots = await ctx.agent.waitSubAgents({
          agentIds,
          timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        });
        if (snapshots.length === 0) {
          return {
            content: "No subagents reached a final status before the timeout.",
            status: "timeout",
            metadata: { kind: "subagent", mode: "lifecycle", subagents: [] },
          };
        }
        if (snapshots.some((snapshot) => !isFinalSnapshotStatus(snapshot.status))) {
          return formatLifecycleResult("wait_agent", snapshots, [
            "wait_agent timed out before a delegated result was ready.",
            "The subagent is still running; call wait_agent again with a longer timeout instead of duplicating the same work locally.",
            "",
            ...snapshots.flatMap((snapshot) => [...formatSnapshot(snapshot), ""]),
          ]);
        }
        return formatLifecycleResult("wait_agent", snapshots);
      } catch (error: any) {
        return toolError("wait_agent", error);
      }
    },
  };
}

export function createSendInputTool(): ToolRegistryEntry {
  return {
    name: "send_input",
    readOnly: true,
    effect: "read",
    description: "Send a follow-up message to an existing subagent thread. If it is still running, pass interrupt:true to cancel and redirect it.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Target subagent id." },
        message: { type: "string", description: "Follow-up message." },
        task: { type: "string", description: "Alias for message." },
        interrupt: { type: "boolean", description: "Cancel a running child before applying this input." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.sendSubAgentInput) {
        return toolRuntimeMissing("send_input");
      }
      const agentId = stringArg(args.agent_id);
      const message = stringArg(args.message) ?? stringArg(args.task);
      if (!agentId || !message) {
        return { content: "Error: send_input requires agent_id and message.", isError: true };
      }
      try {
        const snapshot = await ctx.agent.sendSubAgentInput(agentId, message, ctx.cwd, {
          interrupt: args.interrupt === true,
          parentToolCallId: ctx.toolCall?.id,
          abortSignal: ctx.abortSignal,
        });
        return formatLifecycleResult("send_input", [snapshot], [
          `Sent input to ${snapshot.nickname} (${snapshot.agentName})`,
          `agent_id: ${snapshot.agentId}`,
          `status: ${snapshot.status}`,
        ]);
      } catch (error: any) {
        return toolError("send_input", error);
      }
    },
  };
}

export function createCloseAgentTool(): ToolRegistryEntry {
  return {
    name: "close_agent",
    readOnly: true,
    effect: "read",
    description: "Close a spawned subagent only when the delegated task is cancelled, stale, or no longer needed. Running children are cancelled before closing; do not close a child just because you started doing the same delegated work locally.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Subagent id to close." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.closeSubAgent) {
        return toolRuntimeMissing("close_agent");
      }
      const agentId = stringArg(args.agent_id);
      if (!agentId) {
        return { content: "Error: close_agent requires agent_id.", isError: true };
      }
      try {
        const snapshot = await ctx.agent.closeSubAgent(agentId);
        return formatLifecycleResult("close_agent", [snapshot], [
          `Closed ${snapshot.nickname} (${snapshot.agentName})`,
          `agent_id: ${snapshot.agentId}`,
          `status: ${snapshot.status}`,
        ]);
      } catch (error: any) {
        return toolError("close_agent", error);
      }
    },
  };
}

export function createAgentLifecycleTools(): ToolRegistryEntry[] {
  return [
    createSpawnAgentTool(),
    createWaitAgentTool(),
    createSendInputTool(),
    createCloseAgentTool(),
  ];
}

function resolveProfile(
  cwd: string,
  name: string,
  scope: AgentProfileScope,
  allowProjectAgents: boolean,
): { profile: AgentProfile } | { error: ToolResult } {
  const discovered = discoverAgentProfiles(cwd, scope);
  const profile = findAgentProfile(discovered.profiles, name);
  if (!profile) {
    const available = discovered.profiles.map((item) => item.name).sort().join(", ") || "none";
    return {
      error: {
        content: `Error: unknown subagent profile "${name}". Available profiles: ${available}`,
        isError: true,
      },
    };
  }
  if (profile.source === "project" && !allowProjectAgents) {
    return {
      error: {
        content: [
          `Blocked: subagent profile "${profile.name}" was loaded from project-local .bubble/agents.`,
          "Pass allowProjectAgents: true only when you trust this repository's agent profile prompts.",
        ].join("\n"),
        isError: true,
        status: "blocked",
      },
    };
  }
  return { profile };
}

function formatLifecycleResult(toolName: LifecycleToolName, snapshots: SubagentThreadSnapshot[], header?: string[]): ToolResult {
  const lines = header ?? [`${toolName}: ${snapshots.length} subagent${snapshots.length === 1 ? "" : "s"}`];
  if (!header) lines.push("");
  if (!header) {
    for (const snapshot of snapshots) {
      lines.push(...formatSnapshot(snapshot), "");
    }
  }
  return {
    content: lines.join("\n").trim(),
    status: lifecycleStatus(toolName, snapshots),
    isError: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.status === "failed" || snapshot.status === "blocked"),
    metadata: {
      kind: "subagent",
      mode: "lifecycle",
      subagents: snapshots.map(snapshotToMetadata),
    },
  };
}

function lifecycleStatus(toolName: LifecycleToolName, snapshots: SubagentThreadSnapshot[]): ToolResult["status"] {
  if (toolName === "spawn_agent" || toolName === "send_input" || toolName === "close_agent") {
    return "success";
  }
  if (snapshots.some((snapshot) => !isFinalSnapshotStatus(snapshot.status))) {
    return "timeout";
  }
  return snapshots.every((snapshot) => snapshot.status === "completed" || snapshot.status === "closed") ? "success" : "partial";
}

function isFinalSnapshotStatus(status: SubagentThreadSnapshot["status"]): boolean {
  return status === "completed"
    || status === "failed"
    || status === "blocked"
    || status === "cancelled"
    || status === "closed";
}

function formatSnapshot(snapshot: SubagentThreadSnapshot): string[] {
  const label = `${snapshot.nickname} (${snapshot.agentName})`;
  const lines = [
    `## ${label}`,
    `agent_id: ${snapshot.agentId}`,
    `status: ${snapshot.status}`,
    `task: ${snapshot.task}`,
  ];
  if (snapshot.summary) {
    lines.push("", "Summary:", snapshot.summary);
  } else if (snapshot.status === "completed") {
    lines.push("", "Summary: (no final text summary was produced)");
  }
  if (snapshot.toolNotes.length > 0) {
    lines.push("", "Recent tool notes:", ...snapshot.toolNotes.slice(-8).map((note) => `- ${note}`));
  }
  if (snapshot.error) {
    lines.push("", `Error: ${snapshot.error}`);
  }
  return lines;
}

function snapshotToMetadata(snapshot: SubagentThreadSnapshot): Record<string, unknown> {
  return {
    subAgentId: snapshot.agentId,
    agentName: snapshot.agentName,
    nickname: snapshot.nickname,
    status: snapshot.status === "closed" ? "cancelled" : snapshot.status,
    profileSource: snapshot.profileSource,
    task: snapshot.task,
    summary: snapshot.summary,
    toolNotes: snapshot.toolNotes,
    usage: snapshot.usage,
    error: snapshot.error,
  };
}

function unsupportedProfile(profile: AgentProfile): ToolResult {
  return {
    content: `Error: subagent profile "${profile.name}" uses mode "${profile.mode}", but this runtime only supports readonly lifecycle subagents.`,
    isError: true,
    status: "blocked",
  };
}

function parseScope(value: unknown): AgentProfileScope {
  return value === "project" || value === "both" ? value : "user";
}

function parseApproval(value: unknown): AgentProfileApproval | undefined {
  return value === "fail" || value === "disabled" ? value : undefined;
}

function normalizeAgentIds(value: unknown, single: unknown): string[] | undefined {
  const out: string[] = [];
  if (typeof single === "string" && single.trim()) out.push(single.trim());
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) out.push(item.trim());
    }
  }
  return out.length > 0 ? [...new Set(out)] : undefined;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function snapshotFallbackId(): string {
  return `spawn_${Date.now().toString(36)}`;
}

function toolRuntimeMissing(name: LifecycleToolName): ToolResult {
  return { content: `Error: ${name} requires an agent runtime`, isError: true };
}

function toolError(name: LifecycleToolName, error: any): ToolResult {
  return {
    content: `Error executing ${name}: ${error?.message || String(error)}`,
    isError: true,
  };
}

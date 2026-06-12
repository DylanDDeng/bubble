import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentProfile, AgentProfileApproval, AgentProfileScope } from "../agent/profiles.js";
import { discoverAgentProfiles, findAgentProfile } from "../agent/profiles.js";
import type { SubagentThreadSnapshot } from "../agent/subagent-control.js";
import { formatSubagentRoute } from "../agent/subagent-route-format.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

type LifecycleToolName = "spawn_agent" | "wait_agent" | "send_input" | "close_agent" | "list_agents" | "agent_team";

export interface AgentLifecycleToolOptions {
  /** Working directory used for profile discovery in tool descriptions. */
  cwd?: string;
  /** Trust gate for project-local .bubble/agents profiles (design §10.2). */
  approval?: ApprovalController;
}

/**
 * Session-scoped trust decisions for project profiles, keyed by file path +
 * content hash so an edited file re-prompts (design §10.2). Shared across the
 * lifecycle tools created by one factory call.
 */
class ProjectProfileTrust {
  private readonly approved = new Set<string>();

  constructor(private readonly approval?: ApprovalController) {}

  /** Returns undefined when trusted, else a blocked ToolResult. */
  async ensureTrusted(profile: AgentProfile): Promise<ToolResult | undefined> {
    if (profile.source !== "project") return undefined;
    const filePath = profile.filePath ?? "<unknown>";
    let content: string;
    try {
      content = profile.filePath ? readFileSync(profile.filePath, "utf8") : profile.prompt;
    } catch {
      content = profile.prompt;
    }
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const key = `${filePath}:${contentHash}`;
    if (this.approved.has(key)) return undefined;
    if (!this.approval) {
      return {
        content: [
          `Blocked: subagent profile "${profile.name}" comes from project-local .bubble/agents and needs the user's approval,`,
          "but no approval flow is available in this session. Use a built-in or user-level profile instead.",
        ].join("\n"),
        isError: true,
        status: "blocked",
      };
    }
    const decision = await this.approval.request({
      type: "agent_profile",
      name: profile.name,
      path: filePath,
      contentHash,
      promptPreview: profile.prompt.split("\n").slice(0, 6).join("\n").slice(0, 600),
    });
    if (decision.action === "approve") {
      this.approved.add(key);
      return undefined;
    }
    const feedback = decision.feedback?.trim();
    return {
      content: [
        `Blocked: the user declined to trust project agent profile "${profile.name}".`,
        feedback ? `User feedback: ${feedback}` : "Use a built-in or user-level profile instead.",
      ].join("\n"),
      isError: true,
      status: "blocked",
    };
  }
}

const PROFILE_DESCRIPTION_TTL_MS = 5_000;

/**
 * Custom profile descriptions must reach the model or the whole custom-profile
 * system is unreachable (design §10.1): the agent_type description is built
 * from live profile discovery, refreshed with a short TTL so file edits are
 * picked up on the next turn.
 */
function createProfileLister(cwd: string | undefined) {
  let cachedAt = 0;
  let cached = "";
  return (): string => {
    if (!cwd) return "";
    const now = Date.now();
    if (now - cachedAt < PROFILE_DESCRIPTION_TTL_MS && cached) return cached;
    cachedAt = now;
    try {
      const { profiles } = discoverAgentProfiles(cwd, "both");
      const lines = profiles
        .filter((profile) => !profile.name.startsWith("builtin:"))
        .map((profile) => {
          const tag = profile.source === "project" ? " [project: requires user approval on first use]" : "";
          return `- ${profile.name}${tag} — ${truncateText(profile.description, 120)}`;
        });
      cached = lines.length > 0 ? ` Available profiles:\n${lines.join("\n")}` : "";
    } catch {
      cached = "";
    }
    return cached;
  };
}

export function createSpawnAgentTool(
  options: AgentLifecycleToolOptions = {},
  sharedTrust?: ProjectProfileTrust,
): ToolRegistryEntry {
  const trust = sharedTrust ?? new ProjectProfileTrust(options.approval);
  const listProfiles = createProfileLister(options.cwd);
  const baseDescription = [
    "Start a child subagent in the background and return its agent_id plus random nickname.",
    "The child has an independent thread; call wait_agent later to collect its result.",
    "Proactively delegate multi-file investigations whose intermediate steps would be noise in the main conversation.",
    "Do the work yourself when it takes only a couple of tool calls or needs conversation context — unless the user explicitly asks for a subagent, in which case spawn one.",
    "The child starts with zero context: write the task as a self-contained work order — state the goal, include known file paths or commands, and never make it rediscover knowledge you already hold.",
    "After spawning, do not duplicate the same delegated work locally; either wait for the child or do clearly non-overlapping work.",
    "A child may start as queued when concurrency slots are busy; it starts automatically, no action needed.",
  ].join(" ");
  return {
    name: "spawn_agent",
    readOnly: true,
    effect: "read",
    get description(): string {
      return baseDescription + listProfiles();
    },
    parameters: {
      type: "object",
      properties: {
        agent_type: { type: "string", description: "Subagent profile or role name. Defaults to default. Built-in types include default, explorer, and worker; see the tool description for custom profiles." },
        agent: { type: "string", description: "Alias for agent_type." },
        category: { type: "string", description: "Optional semantic category for model/thinking routing, such as quick, deep, explore, review, frontend, or writing." },
        message: { type: "string", description: "Initial task for the subagent." },
        task: { type: "string", description: "Alias for message." },
        fork_context: { type: "boolean", description: "When true, copy recent parent conversation into the child thread." },
        agentScope: {
          type: "string",
          enum: ["user", "project", "both"],
          description: "Which profile locations to load. Defaults to built-ins plus user and project profiles; project profiles need the user's one-time approval.",
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
      const resolved = resolveProfile(ctx.cwd, profileName, parseScope(args.agentScope));
      if ("error" in resolved) return resolved.error;
      const modeBlock = unsupportedProfile(resolved.profile);
      if (modeBlock) return modeBlock;
      const trustBlock = await trust.ensureTrusted(resolved.profile);
      if (trustBlock) return trustBlock;

      try {
        const snapshot = await ctx.agent.spawnSubAgent(message, ctx.cwd, {
          profile: resolved.profile,
          parentToolCallId: ctx.toolCall?.id ?? snapshotFallbackId(),
          category: stringArg(args.category),
          approval: parseApproval(args.approval),
          abortSignal: ctx.abortSignal,
          forkContext: args.fork_context === true,
        });
        return formatLifecycleResult("spawn_agent", [snapshot], [
          `Spawned ${snapshot.nickname} (${formatSnapshotRole(snapshot)})`,
          `agent_id: ${snapshot.agentId}`,
          `status: ${snapshot.status}`,
          ...formatRouteLines(snapshot),
          ...spawnNextSteps(snapshot),
          "counting: this spawn result creates one unique subagent; later wait_agent results for the same agent_id are updates, not additional subagents",
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
      "If the wait times out while children are still queued or running, call wait_agent again with a longer timeout instead of redoing the same delegated work locally.",
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
            ...waitTimeoutGuidance(snapshots),
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
    description: "Send a follow-up message to an existing subagent thread. If it is still running, pass interrupt:true to cancel and redirect it. Restarting a finished child goes through the scheduler like any spawn.",
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
          ...(snapshot.status === "queued" ? [queuedStatusLine(snapshot)] : []),
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

export function createListAgentsTool(): ToolRegistryEntry {
  return {
    name: "list_agents",
    readOnly: true,
    effect: "read",
    description: "List this session's subagents with their current status. Use it to recall which children exist before spawning duplicates or narrating progress.",
    parameters: {
      type: "object",
      properties: {
        status_filter: {
          type: "array",
          description: "Only include these statuses (queued, running, completed, failed, blocked, cancelled, closed).",
          items: { type: "string" },
        },
        include_closed: { type: "boolean", description: "Include closed subagents. Defaults to false." },
      },
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.listSubAgents) {
        return toolRuntimeMissing("list_agents");
      }
      const filter = Array.isArray(args.status_filter)
        ? new Set(args.status_filter.filter((item: unknown): item is string => typeof item === "string"))
        : undefined;
      const includeClosed = args.include_closed === true;
      const snapshots = ctx.agent.listSubAgents()
        .filter((snapshot) => includeClosed || snapshot.status !== "closed")
        .filter((snapshot) => !filter || filter.size === 0 || filter.has(snapshot.status));
      if (snapshots.length === 0) {
        return {
          content: "No subagents match. Spawn one with spawn_agent when delegation helps.",
          metadata: { kind: "subagent", mode: "lifecycle", subagents: [] },
        };
      }
      const lines = [
        `${snapshots.length} subagent${snapshots.length === 1 ? "" : "s"}:`,
        ...snapshots.map((snapshot) => {
          const usage = snapshot.usage ? ` tokens=${snapshot.usage.totalTokens}` : "";
          const queued = snapshot.status === "queued" && snapshot.queuePosition !== undefined
            ? ` queue_position=${snapshot.queuePosition}`
            : "";
          return `- ${snapshot.nickname} (${formatSnapshotRole(snapshot)}) agent_id=${snapshot.agentId} status=${snapshot.status}${queued}${usage} task=${truncateText(snapshot.task, 80)}`;
        }),
      ];
      return {
        content: lines.join("\n"),
        metadata: {
          kind: "subagent",
          mode: "lifecycle",
          subagents: snapshots.map(snapshotToMetadata),
        },
      };
    },
  };
}

/** Items bound for one agent_team call (design §1.2). */
export const AGENT_TEAM_MIN_ITEMS = 2;
export const AGENT_TEAM_MAX_ITEMS = 32;

export function createAgentTeamTool(
  options: AgentLifecycleToolOptions = {},
  sharedTrust?: ProjectProfileTrust,
): ToolRegistryEntry {
  const trust = sharedTrust ?? new ProjectProfileTrust(options.approval);
  return {
    name: "agent_team",
    readOnly: true,
    effect: "read",
    description: [
      "Run the same task template over many items as parallel subagents (homogeneous map fan-out).",
      "Proactively use this when a task naturally splits into the same read-only operation over several independent items.",
      "Each item becomes one child with its own agent_id; the call blocks until every member reaches a final state and returns results in item order.",
      "Failed members can be resumed individually with send_input afterwards.",
      `Use ${AGENT_TEAM_MIN_ITEMS}-${AGENT_TEAM_MAX_ITEMS} items. agent_team must be the ONLY tool call in your response; run other tools or further teams after it returns.`,
      "Scoping rule: split items so members never overlap or conflict with each other.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short (3-5 word) description of the team, shown in the UI." },
        agent_type: { type: "string", description: "Subagent profile for every member. Defaults to default." },
        category: { type: "string", description: "Optional semantic category for model/thinking routing." },
        prompt_template: { type: "string", description: "Task template applied to each item. Must contain the literal placeholder {{item}}." },
        items: {
          type: "array",
          description: `Items to fan out over (${AGENT_TEAM_MIN_ITEMS}-${AGENT_TEAM_MAX_ITEMS} unique strings); each becomes one subagent.`,
          items: { type: "string" },
        },
      },
      required: ["description", "prompt_template", "items"],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.runAgentTeam) {
        return toolRuntimeMissing("agent_team");
      }
      const template = stringArg(args.prompt_template);
      if (!template) {
        return { content: "Error: agent_team requires prompt_template.", isError: true };
      }
      if (!template.includes("{{item}}")) {
        return {
          content: "Error: prompt_template must contain the literal placeholder {{item}} — it is replaced with each item. Example: \"Review {{item}} for risks.\"",
          isError: true,
        };
      }
      const rawItems = Array.isArray(args.items)
        ? args.items.filter((item: unknown): item is string => typeof item === "string" && !!item.trim()).map((item: string) => item.trim())
        : [];
      const items = [...new Set(rawItems)];
      if (items.length < AGENT_TEAM_MIN_ITEMS) {
        return {
          content: `Error: agent_team needs at least ${AGENT_TEAM_MIN_ITEMS} unique items after deduplication (got ${items.length}). For a single task use spawn_agent instead.`,
          isError: true,
        };
      }
      if (items.length > AGENT_TEAM_MAX_ITEMS) {
        return {
          content: `Error: agent_team accepts at most ${AGENT_TEAM_MAX_ITEMS} items (got ${items.length}). Split the work into sequential teams.`,
          isError: true,
        };
      }
      const profileName = stringArg(args.agent_type) ?? "default";
      const resolved = resolveProfile(ctx.cwd, profileName, "both");
      if ("error" in resolved) return resolved.error;
      const modeBlock = unsupportedProfile(resolved.profile);
      if (modeBlock) return modeBlock;
      const trustBlock = await trust.ensureTrusted(resolved.profile);
      if (trustBlock) return trustBlock;

      try {
        const snapshots = await ctx.agent.runAgentTeam(ctx.cwd, {
          profile: resolved.profile,
          category: stringArg(args.category),
          promptTemplate: template,
          items,
          parentToolCallId: ctx.toolCall?.id ?? snapshotFallbackId(),
          emitUpdate: ctx.emitUpdate,
          abortSignal: ctx.abortSignal,
        });
        const counts = teamStatusCounts(snapshots);
        const lines = [
          `agent_team "${stringArg(args.description) ?? "team"}": ${snapshots.length} members — ${counts}`,
          "Failed or cancelled members can be resumed individually with send_input (see per-member guidance below).",
          "",
          ...snapshots.flatMap((snapshot, index) => [
            `### item ${index + 1}: ${truncateText(items[index] ?? "", 100)}`,
            ...formatSnapshot(snapshot),
            "",
          ]),
        ];
        return {
          content: lines.join("\n").trim(),
          status: snapshots.every((snapshot) => snapshot.status === "completed")
            ? "success"
            : snapshots.some((snapshot) => snapshot.status === "completed")
              ? "partial"
              : "blocked",
          isError: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.status !== "completed"),
          metadata: {
            kind: "subagent",
            mode: "team",
            subagents: snapshots.map(snapshotToMetadata),
          },
        };
      } catch (error: any) {
        return toolError("agent_team", error);
      }
    },
  };
}

function teamStatusCounts(snapshots: SubagentThreadSnapshot[]): string {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    counts.set(snapshot.status, (counts.get(snapshot.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(" / ");
}

export function createAgentLifecycleTools(options: AgentLifecycleToolOptions = {}): ToolRegistryEntry[] {
  const trust = new ProjectProfileTrust(options.approval);
  return [
    createSpawnAgentTool(options, trust),
    createWaitAgentTool(),
    createSendInputTool(),
    createCloseAgentTool(),
    createListAgentsTool(),
    createAgentTeamTool(options, trust),
  ];
}

function resolveProfile(
  cwd: string,
  name: string,
  scope: AgentProfileScope,
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
  return { profile };
}

function spawnNextSteps(snapshot: SubagentThreadSnapshot): string[] {
  if (snapshot.status === "queued" && snapshot.queuePosition !== undefined && snapshot.queuePosition > 0) {
    return [
      queuedStatusLine(snapshot),
      "next: continue other non-overlapping work, then call wait_agent to collect the result",
    ];
  }
  return [
    `next: call wait_agent for ${snapshot.agentId} before reporting this subagent's current status or final result`,
  ];
}

function queuedStatusLine(snapshot: SubagentThreadSnapshot): string {
  const behind = snapshot.queuePosition !== undefined && snapshot.queuePosition > 1
    ? ` behind ${snapshot.queuePosition - 1} child${snapshot.queuePosition - 1 === 1 ? "" : "ren"}`
    : "";
  return `queued: waiting for a concurrency slot${behind}; it starts automatically — no action needed`;
}

function waitTimeoutGuidance(snapshots: SubagentThreadSnapshot[]): string[] {
  const lines: string[] = [];
  const queued = snapshots.filter((snapshot) => snapshot.status === "queued");
  const running = snapshots.filter((snapshot) => snapshot.status === "running");
  if (queued.length > 0) {
    lines.push(`${queued.length} child${queued.length === 1 ? " is" : "ren are"} queued for a concurrency slot and will start automatically.`);
  }
  if (running.length > 0) {
    lines.push(`${running.length} child${running.length === 1 ? " is" : "ren are"} still running.`);
  }
  lines.push("Call wait_agent again with a longer timeout instead of duplicating the same work locally.");
  return lines;
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
  if (toolName === "spawn_agent" || toolName === "send_input" || toolName === "close_agent" || toolName === "list_agents") {
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
  const label = `${snapshot.nickname} (${formatSnapshotRole(snapshot)})`;
  const lines = [
    `## ${label}`,
    `agent_id: ${snapshot.agentId}`,
    `status: ${snapshot.status}`,
  ];
  if (snapshot.category) {
    lines.push(`category: ${snapshot.category}`);
  }
  lines.push(...formatRouteLines(snapshot));
  lines.push(`task: ${snapshot.task}`);
  if (snapshot.status === "queued") {
    lines.push(queuedStatusLine(snapshot));
  }
  if (snapshot.summary) {
    lines.push("", "Summary:", snapshot.summary);
  } else if (snapshot.status === "completed") {
    lines.push("", "Summary: (no final text summary was produced)");
  }
  if (snapshot.worktree && isFinalSnapshotStatus(snapshot.status)) {
    if (snapshot.worktree.changed) {
      lines.push(
        "",
        `Worktree with changes: ${snapshot.worktree.path}`,
        "Review the diff there and apply / cherry-pick / discard; the parent working tree was never touched.",
        ...(snapshot.worktree.diffStat ? ["Diff stat:", snapshot.worktree.diffStat] : []),
      );
    } else {
      lines.push("", "Worktree: no changes were left behind (removed automatically).");
    }
  }
  if (snapshot.toolNotes.length > 0) {
    lines.push("", "Recent tool notes:", ...snapshot.toolNotes.slice(-8).map((note) => `- ${note}`));
  }
  if (snapshot.error) {
    lines.push("", `Error: ${snapshot.error}`);
  }
  lines.push(...finalGuidanceLines(snapshot));
  return lines;
}

/**
 * Per-reason guidance (design §3.1): a resume hint is rendered iff the
 * runtime judged the run resumable. Wait timeouts are not final states and
 * never reach this function with a finalReason.
 */
function finalGuidanceLines(snapshot: SubagentThreadSnapshot): string[] {
  if (!isFinalSnapshotStatus(snapshot.status) || snapshot.status === "completed" || snapshot.status === "closed") {
    return [];
  }
  switch (snapshot.finalReason) {
    case "rate_limited_exhausted":
      return [
        "",
        resumeLine(snapshot.agentId),
        "note: the provider was rate limited; prefer resuming later or running fewer children at once",
      ];
    case "failed_transient":
    case "cancelled_interrupt":
    case "cancelled_user":
    case "cancelled_parent_abort":
      return ["", resumeLine(snapshot.agentId)];
    case "cancelled_budget":
      return ["", "budget exhausted — do not resume this child; integrate what it already reported and narrow the task if more is needed"];
    case "blocked":
      return ["", "blocked: re-spawn with an adjusted profile or approval setting — resuming as-is would hit the same block"];
    case "failed_fatal":
      return [];
    default:
      return snapshot.resumable ? ["", resumeLine(snapshot.agentId)] : [];
  }
}

function resumeLine(agentId: string): string {
  return `resume: call send_input with agent_id ${agentId} to continue this child with its context intact`;
}

function formatSnapshotRole(snapshot: SubagentThreadSnapshot): string {
  return [snapshot.agentName, snapshot.category ? `/${snapshot.category}` : ""].join("") || "default";
}

function formatRouteLines(snapshot: SubagentThreadSnapshot): string[] {
  const route = formatSubagentRoute(snapshot.route, { includeThinking: true });
  return route ? [`route: ${route}`] : [];
}

function snapshotToMetadata(snapshot: SubagentThreadSnapshot): Record<string, unknown> {
  return {
    subAgentId: snapshot.agentId,
    agentName: snapshot.agentName,
    nickname: snapshot.nickname,
    status: snapshot.status === "closed" ? "cancelled" : snapshot.status,
    finalReason: snapshot.finalReason,
    resumable: snapshot.resumable,
    profileSource: snapshot.profileSource,
    category: snapshot.category,
    route: snapshot.route,
    task: snapshot.task,
    summary: snapshot.summary,
    toolNotes: snapshot.toolNotes,
    usage: snapshot.usage,
    error: snapshot.error,
  };
}

function unsupportedProfile(profile: AgentProfile): ToolResult | undefined {
  if (profile.mode === "readonly" || profile.mode === "write_worktree") return undefined;
  return {
    content: `Error: subagent profile "${profile.name}" uses mode "${profile.mode}", which is not supported. Use "readonly" for investigation or "write_worktree" for isolated write work.`,
    isError: true,
    status: "blocked",
  };
}

function parseScope(value: unknown): AgentProfileScope {
  return value === "project" || value === "user" ? value : "both";
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

function truncateText(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
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

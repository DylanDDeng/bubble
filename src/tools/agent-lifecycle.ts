import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentProfile, AgentProfileApproval, AgentProfileScope } from "../agent/profiles.js";
import { discoverAgentProfiles, findAgentProfile } from "../agent/profiles.js";
import { parseThinkingLevel } from "../agent/categories.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../types.js";
import type { SubagentThreadSnapshot } from "../agent/subagent-control.js";
import { buildWorkflowResultBlock, workflowMemberWarning } from "../agent/workflow/control.js";
import { precompileWorkflowScript } from "../agent/workflow/runtime.js";
import { formatSubagentRoute } from "../agent/subagent-route-format.js";
import type { ApprovalController } from "../approval/types.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

type LifecycleToolName = "spawn_agent" | "wait_agent" | "send_input" | "close_agent" | "list_agents" | "run_workflow" | "wait_workflow";

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
    "Best for helpers whose results you want to read and react to individually. For a uniform sweep over many items, or when member results should be aggregated before returning, weigh run_workflow instead. If the user asked for a workflow, an orchestration, or an agent team, that is run_workflow, not this tool.",
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
        model: { type: "string", description: "Optional per-call model for this child, overriding category and profile. Bare name (e.g. claude-haiku-4-5) uses the parent provider; provider:model (e.g. anthropic:claude-opus-4-1) selects cross-provider." },
        effort: { type: "string", enum: [...THINKING_LEVELS], description: "Optional per-call thinking level for this child, overriding category and profile." },
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

      const effort = parseEffortArg(args.effort);
      if ("error" in effort) return effort.error;

      try {
        const snapshot = await ctx.agent.spawnSubAgent(message, ctx.cwd, {
          profile: resolved.profile,
          parentToolCallId: ctx.toolCall?.id ?? snapshotFallbackId(),
          category: stringArg(args.category),
          model: stringArg(args.model),
          effort: effort.value,
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
    deferred: true,
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
    deferred: true,
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


export function createRunWorkflowTool(
  options: AgentLifecycleToolOptions = {},
  sharedTrust?: ProjectProfileTrust,
): ToolRegistryEntry {
  const trust = sharedTrust ?? new ProjectProfileTrust(options.approval);
  // Single-flight: the interactive UI holds ONE pending approval at a time,
  // so concurrent trust prompts from a parallel() fan-out would overwrite
  // each other's resolver and hang the workflow. Serializing here also lets
  // the first approval satisfy the rest of the same profile via the cache.
  let trustChain: Promise<unknown> = Promise.resolve();
  const ensureProfileTrustedSerially = (profile: AgentProfile): Promise<ToolResult | undefined> => {
    const next = trustChain.then(() => trust.ensureTrusted(profile));
    trustChain = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    name: "run_workflow",
    readOnly: true,
    effect: "read",
    description: [
      "Run an LLM-authored JavaScript orchestration script (dynamic workflow) that coordinates many subagents with deterministic control flow.",
      "This is THE tool whenever the user asks for a workflow, an orchestration, or an agent team — even a small one; do not substitute parallel spawn_agent calls for an explicit request.",
      "Also use it for tasks that need loops, conditional fan-out, or staged pipelines over dozens of subagents whose intermediate steps should stay out of this conversation — e.g. a codebase-wide audit, a migration, or cross-checked research.",
      "The script's only capability is agent(prompt, opts?) — each call spawns a sandboxed readonly subagent; opts may set {model, effort, agentType, category, schema, label}. Give each agent a short unique label. Also available: parallel(thunks), pipeline(items, ...stages), phase(title), log(msg), the global args, and budget {total, spent(), remaining()}.",
      "End the script with `return <value>`; that value (only) comes back to you. Return distilled conclusions, not raw agent transcripts — reduce inside the script (plain JS filtering or a final synthesis agent); a return value past ~8000 chars reaches you truncated (full copy on disk). The script has no filesystem/shell/network/clock/random access. run_workflow must be the ONLY tool call in your response; it blocks until the workflow finishes.",
      "A failed or blocked agent() resolves to null inside parallel/pipeline (a bare await agent() throws instead): check for null slots and return which items failed alongside the results — never silently drop them. Keep a final synthesis/aggregation step inside try/catch (or parallel) so its failure cannot discard every completed member's work.",
      "Write plain JavaScript only — no TypeScript syntax, no import/require, and no Date or Math.random (they throw; pass timestamps in via args).",
      "parallel() takes an array of FUNCTIONS, not promises: await parallel(items.map(item => () => agent(...))). Passing promises throws a TypeError.",
      "Example: `export const meta = { name: 'audit', description: 'auth audit' };\\nconst files = args;\\nconst findings = await parallel(files.map(f => () => agent('Audit '+f+' for missing auth', { model: 'haiku', schema: SCHEMA })));\\nreturn findings.filter(Boolean);`",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "The JavaScript orchestration script. Starts with `export const meta = {name, description}`; ends with `return <value>`." },
        args: { description: "Optional JSON value exposed to the script as the global `args` (e.g. a list of target paths or a question)." },
        title: { type: "string", description: "Optional short label shown in the UI." },
      },
      required: ["script"],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.startWorkflow) {
        return toolRuntimeMissing("run_workflow");
      }
      const script = stringArg(args.script);
      if (!script) {
        return { content: "Error: run_workflow requires a non-empty script.", isError: true };
      }
      // Submit-time syntax probe (same QuickJS engine, compile-only): a broken
      // script fails HERE as the immediate tool result instead of one turn
      // later through the background delivery path.
      const precheck = await precompileWorkflowScript(script);
      if (!precheck.ok) {
        return {
          content: `run_workflow rejected before launch: ${precheck.error}. Fix the script and re-issue run_workflow.`,
          isError: true,
        };
      }
      try {
        const { runId, title } = ctx.agent.startWorkflow(ctx.cwd, {
          script,
          args: args.args,
          title: stringArg(args.title),
          parentToolCallId: ctx.toolCall?.id ?? snapshotFallbackId(),
          abortSignal: ctx.abortSignal,
          // Project-local profiles named via agent(..., {agentType}) pass the
          // same first-use trust gate as spawn_agent (Codex review on #58).
          ensureProfileTrusted: ensureProfileTrustedSerially,
        });
        return {
          content: [
            `run_workflow "${title}" started in the background (run_id: ${runId}).`,
            `It coordinates subagents on its own; its result is injected automatically before your next turn.`,
            `To block for it now (required in non-interactive mode), call wait_workflow with run_id ${runId}.`,
          ].join("\n"),
          status: "success",
          metadata: { kind: "subagent", mode: "workflow", runId },
        };
      } catch (error: any) {
        return toolError("run_workflow", error);
      }
    },
  };
}

export function createWaitWorkflowTool(): ToolRegistryEntry {
  return {
    name: "wait_workflow",
    readOnly: true,
    effect: "read",
    description: [
      "Block until a background run_workflow finishes and return its result.",
      "If it times out while still running, call wait_workflow again with a longer timeout.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run_id returned by run_workflow." },
        timeout_ms: { type: "number", description: "Max time to wait (default 600000)." },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.agent?.waitWorkflow) {
        return toolRuntimeMissing("wait_workflow");
      }
      const runId = stringArg(args.run_id);
      if (!runId) {
        return { content: "Error: wait_workflow requires run_id.", isError: true };
      }
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
      const snapshot = await ctx.agent.waitWorkflow(runId, timeoutMs);
      if (!snapshot) {
        return { content: `Error: unknown workflow run_id "${runId}".`, isError: true };
      }
      if (snapshot.status === "running") {
        return {
          content: `workflow "${snapshot.title}" (${runId}) still running (${snapshot.agentCount} agents so far). Call wait_workflow again with a longer timeout.`,
          status: "timeout",
        };
      }
      if (!snapshot.result || !snapshot.result.ok) {
        return {
          content: [
            `workflow "${snapshot.title}" (${runId}) ${snapshot.status}: ${snapshot.result && !snapshot.result.ok ? snapshot.result.error : "no result"}`,
            ...(snapshot.logs.length > 0 ? ["", "Log:", ...snapshot.logs.slice(-20)] : []),
          ].join("\n"),
          isError: true,
          status: "blocked",
          metadata: { kind: "subagent", mode: "workflow", subagents: snapshot.snapshots.map(snapshotToMetadata) },
        };
      }
      const memberWarning = workflowMemberWarning(snapshot);
      return {
        content: [
          `workflow "${snapshot.title}" (${runId}) completed (${snapshot.agentCount} agents).`,
          ...(memberWarning ? [memberWarning] : []),
          ...(snapshot.logs.length > 0 ? ["", "Log:", ...snapshot.logs.slice(-20)] : []),
          "",
          ...buildWorkflowResultBlock(snapshot),
        ].join("\n"),
        status: "success",
        metadata: { kind: "subagent", mode: "workflow", subagents: snapshot.snapshots.map(snapshotToMetadata) },
      };
    },
  };
}

export function createAgentLifecycleTools(options: AgentLifecycleToolOptions = {}): ToolRegistryEntry[] {
  const trust = new ProjectProfileTrust(options.approval);
  return [
    createSpawnAgentTool(options, trust),
    createWaitAgentTool(),
    createSendInputTool(),
    createCloseAgentTool(),
    createListAgentsTool(),
    createRunWorkflowTool(options, trust),
    createWaitWorkflowTool(),
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

/**
 * Parses an optional per-call effort/thinking override. An absent value yields
 * `{ value: undefined }`; a present-but-invalid value is a teaching error so the
 * model corrects it rather than silently running at the wrong level.
 */
function parseEffortArg(value: unknown): { value: ThinkingLevel | undefined } | { error: ToolResult } {
  if (value === undefined || value === null) return { value: undefined };
  const parsed = parseThinkingLevel(value);
  if (!parsed) {
    return {
      error: {
        content: `Error: effort must be one of ${THINKING_LEVELS.join(", ")} (got ${JSON.stringify(value)}).`,
        isError: true,
      },
    };
  }
  return { value: parsed };
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

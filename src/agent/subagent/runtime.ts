/**
 * Subagent thread lifecycle + dynamic-workflow execution.
 *
 * Extracted from Agent: spawn/wait/send/close, the scheduler dispatch and its
 * terminal callbacks, admission, ingestion, worktree-backed child construction
 * and the QuickJS workflow driver all lived on the Agent class alongside the
 * conversation loop, sharing its private fields.
 *
 * Two rules keep the boundary honest:
 *  - Everything the runtime needs from the parent arrives through
 *    `SubagentRuntimeParent` as a LIVE accessor, never a construction-time
 *    snapshot: `/model` reassigns the parent's provider/model/thinking
 *    mid-session and children must inherit the current values.
 *  - Nothing is pushed back into the parent. Tool updates and ingestion
 *    notices are PULLED (`drainToolUpdates` / `drainIngestionNotices`) at the
 *    points in Agent.run() that previously called the private flush methods,
 *    matching ResultIntegrator.drainNotices.
 *
 * `new Agent(...)` stays on Agent, reached through `parent.createChild`. That
 * is the only genuine call back into the parent, and keeping it there is what
 * guarantees the child-construction argument set — including the fields that
 * must stay ABSENT (onMessageAppend, sessionID, routing catalog) — has exactly
 * one definition site.
 */
import { randomUUID } from "node:crypto";
import { buildSystemPrompt } from "../../system-prompt.js";
import { buildToolPromptOptions } from "../../tools/index.js";
import { appendOutputSchemaInstructions, buildSchemaCorrectionPrompt, validateStructuredSummary } from "../structured-output.js";
import { runWorkflow, WorkflowConcurrencyGate, type AgentDispatchResult, type WorkflowAgentSpec } from "../workflow/runtime.js";
import { assignAgentNickname, discoverAgentProfiles, findAgentProfile, validateAgentProfileTools, type AgentProfile, type SubagentRunResult } from "../profiles.js";
import { snapshotSubagentThread, subagentResultFromThread, type PendingSubagentToolUpdate, type SubagentThreadRecord, type SubagentThreadSnapshot } from "../subagent-control.js";
import { SubagentStore } from "../subagent-store.js";
import { SubagentScheduler, type SubagentRunOutcome } from "../subagent-scheduler.js";
import { ChildRunner, classifySubagentAbortReason, type ChildRunOptions } from "../child-runner.js";
import { ResultIntegrator } from "../result-integrator.js";
import { SubagentAbortError } from "../abort-errors.js";
import { createSubagentWorktree, finalizeSubagentWorktree } from "../worktree.js";
import { createWorktreeChildTools, isolateReadonlyChildFileTools } from "../../tools/child-tools.js";
import { mergeAgentCategories, parseThinkingLevel, type AgentCategoriesConfig, type ResolvedSubagentRoute } from "../categories.js";
import { composeAbortSignals } from "../budget-ledger.js";
import type { SubagentRouter } from "./router.js";
import type { AgentEvent, ContentPart, Message, PermissionMode, Provider, ThinkingLevel, ToolRegistryEntry, ToolUpdate } from "../../types.js";
// Type-only, so this never becomes a runtime import cycle with agent.js.
import type { AgentSubagentRuntimeConfig } from "../../agent.js";
import type { HookCombinedResult } from "../../hooks/index.js";

/** The child agent surface the runtime drives; structurally satisfied by Agent. */
export type ChildAgentLike = NonNullable<SubagentThreadRecord["agent"]>;

export interface ChildAgentSpec {
  provider: Provider;
  providerId: string;
  model: string;
  tools: ToolRegistryEntry[];
  thinkingLevel: ThinkingLevel;
  mode: PermissionMode;
  maxTurns?: number;
  budgetSource: { runId: string; subAgentId?: string };
  systemPrompt: string;
  subAgentId: string;
  /** Cross-restart resume history (design §7); already detached from the record. */
  resumeMessages?: Message[];
  /** Seed the child with the parent's recent context under its own system prompt. */
  forkContext?: boolean;
}

export interface SubagentRuntimeParent {
  /** LIVE — /model reassigns these mid-session. */
  readonly provider: Provider;
  readonly providerId: string;
  /** API-facing model id, already stripped of any "provider:" prefix. */
  readonly apiModel: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly memoryPrompt: string | undefined;
  readonly providerFactory: ((route: ResolvedSubagentRoute) => Provider | Promise<Provider>) | undefined;
  /**
   * The UNFILTERED tool map — deferred-but-unlocked entries included. Profile
   * admission and child tool selection both depend on seeing every registered
   * tool; handing them the active (deferred-filtered) list would block
   * profiles that explicitly include an MCP or otherwise deferred tool.
   */
  allTools(): ToolRegistryEntry[];
  createChild(spec: ChildAgentSpec): ChildAgentLike;
  runExternalHook(
    input: { eventName: string; cwd: string; runId?: string; target?: string; payload?: Record<string, unknown> },
    abortSignal?: AbortSignal,
  ): Promise<{ result: HookCombinedResult; events: AgentEvent[] }>;
}

export interface SubagentRuntimeDeps {
  parent: SubagentRuntimeParent;
  router: SubagentRouter;
  categories: AgentCategoriesConfig;
  config: AgentSubagentRuntimeConfig;
  /**
   * Initial persist directory. Session switches repoint it through
   * `repointPersistDir` (the TUI reuses one Agent across switches).
   */
  persistDir?: string;
}

export class SubagentRuntime {
  private readonly parent: SubagentRuntimeParent;
  private readonly router: SubagentRouter;
  private readonly categories: AgentCategoriesConfig;
  private readonly subagentsConfig: AgentSubagentRuntimeConfig;
  /** Public so Agent can expose the same private-field access tests rely on. */
  readonly store: SubagentStore;
  private readonly scheduler: SubagentScheduler;
  private readonly childRunner: ChildRunner;
  private readonly resultIntegrator = new ResultIntegrator();
  private pendingUpdates: PendingSubagentToolUpdate[] = [];
  private readonly updateWakers = new Set<() => void>();

  constructor(deps: SubagentRuntimeDeps) {
    this.parent = deps.parent;
    this.router = deps.router;
    this.categories = deps.categories;
    this.subagentsConfig = deps.config;
    // Eager, with loadPersisted() in the constructor: list_agents must return
    // persisted children before any spawn happens this process.
    this.store = new SubagentStore(deps.persistDir);
    this.store.loadPersisted();
    this.scheduler = new SubagentScheduler({
      maxActiveSubagents: this.subagentsConfig.maxActiveSubagents,
      launchBurst: this.subagentsConfig.launchBurst,
      launchIntervalMs: this.subagentsConfig.launchIntervalMs,
      rateLimitMaxAttempts: this.subagentsConfig.rateLimitMaxAttempts,
      rateLimitBackoffMs: this.subagentsConfig.rateLimitBackoffMs,
      transportRetryMaxAttempts: this.subagentsConfig.transportRetryMaxAttempts,
      transportRetryBackoffMs: this.subagentsConfig.transportRetryBackoffMs,
      getCategoryLimit: (category) => mergeAgentCategories(this.categories)[category]?.maxConcurrent,
    });
    this.childRunner = new ChildRunner({
      allTools: () => this.parent.allTools(),
      emit: (record, options, status, event, message) => this.emitSubagentLifecycle(record, options, status, event, message),
      runLifecycleHook: (record, cwd, eventName, status, error, abortSignal) =>
        this.runSubagentLifecycleHookFor(record, cwd, eventName, status, error, abortSignal),
      finalizeBlocked: (record, error, options) => this.finalizeSubagentBlocked(record, error, options),
      createInstance: (record, tools, cwd, forkContext) => this.createSubAgentInstance(record, tools, cwd, forkContext),
      notifyWaiters: (record) => this.store.notifyWaiters(record),
      onFinal: (record, options) => {
        this.reclaimWorktree(record);
        // Workflow-internal agents are not persisted (they never re-import into
        // the store on restart) and never ingest into parent context (option C).
        if (!record.workflowInternal) {
          this.store.persist(record);
          this.maybeEnqueueIngestion(record, options);
        }
      },
    });
  }

  // ---- parent-facing view: everything Agent.run() pulls ----

  /** True when a background child has queued an update the loop should drain. */
  hasPendingUpdates(): boolean {
    return this.pendingUpdates.length > 0;
  }

  /** Follows a session switch: evicts the old session's final children and loads the new one's. */
  repointPersistDir(persistDir: string | undefined): void {
    this.store.repoint(persistDir);
  }

  /**
   * Inspects and cleans up a child's worktree at ANY terminal outcome:
   * unchanged → removed; changed → kept for the parent to review, with a
   * diff stat in the handoff (§8). Called from ChildRunner's onFinal and
   * from all three scheduler-terminal callbacks — the scheduler paths used
   * to skip reclamation entirely, leaking the directory and its git
   * registration whenever a write child exhausted its retries
   * (known-defects #1).
   *
   * When the directory was removed (= the child left no changes, so there
   * is no file state to lose), the record's worktree reference is cleared:
   * a kept reference would send a later resume into a deleted directory —
   * clearing it makes the resume path rebuild a fresh worktree instead
   * (see ChildRunner's reuse guard).
   */
  private reclaimWorktree(record: SubagentThreadRecord): void {
    if (!record.worktree) return;
    // finalizeSubagentWorktree is idempotent (already-finalized worktrees
    // return unchanged); only the call that actually performed finalization
    // may push the handoff note, or re-finalization would duplicate it.
    const alreadyFinalized = record.worktree.changed !== undefined;
    finalizeSubagentWorktree(record.worktree);
    if (!alreadyFinalized && record.worktree.changed) {
      record.toolNotes.push(`worktree: changes left in ${record.worktree.path} — review the diff before applying`);
    }
    if (record.worktree.removed) record.worktree = undefined;
  }

  /** Registers a waker so a blocked tool-execution loop learns about updates. */
  subscribe(wake: () => void): () => void {
    this.updateWakers.add(wake);
    return () => this.updateWakers.delete(wake);
  }

  /**
   * Completed background children whose summaries should reach parent context
   * before the next inference turn (design §5). Pulled, not injected.
   */
  drainIngestionNotices(): string[] {
    if (!this.resultIntegrator.hasPending()) return [];
    return this.resultIntegrator.drainNotices(this.store);
  }

  async runSubAgent(
    input: string | ContentPart[],
    cwd: string,
    options: {
      profile: AgentProfile;
      runId: string;
      subAgentId: string;
      parentToolCallId: string;
      category?: string;
      route?: ResolvedSubagentRoute;
      approval?: "fail" | "disabled";
      emitUpdate?: (update: ToolUpdate) => void;
      description?: string;
      abortSignal?: AbortSignal;
      nickname?: string;
      forkContext?: boolean;
    },
  ): Promise<SubagentRunResult> {
    const record = this.createSubagentThreadRecord({
      profile: options.profile,
      task: typeof input === "string" ? input : "(multimodal task)",
      runId: options.runId,
      agentId: options.subAgentId,
      parentToolCallId: options.parentToolCallId,
      parentToolName: "subagent",
      nickname: options.nickname,
      route: options.route ?? this.router.resolve(options.profile, options.category),
    });
    this.store.set(record);
    const approval = options.approval ?? options.profile.approval;
    const admissionError = this.admitSubagentProfile(record, approval);
    if (admissionError) {
      this.finalizeSubagentBlocked(record, admissionError, { directEmit: options.emitUpdate });
      return subagentResultFromThread(record);
    }
    record.promise = this.dispatchSubagentRun(record, input, cwd, {
      approval,
      abortSignal: options.abortSignal,
      forkContext: options.forkContext,
      directEmit: options.emitUpdate,
    });
    await record.promise;
    return subagentResultFromThread(record);
  }

  async spawnSubAgent(
    input: string | ContentPart[],
    cwd: string,
    options: {
      profile: AgentProfile;
      parentToolCallId: string;
      category?: string;
      model?: string;
      effort?: ThinkingLevel;
      route?: ResolvedSubagentRoute;
      approval?: "fail" | "disabled";
      description?: string;
      abortSignal?: AbortSignal;
      forkContext?: boolean;
    },
  ): Promise<SubagentThreadSnapshot> {
    const route = options.route
      ?? this.router.resolve(options.profile, options.category, { model: options.model, effort: options.effort });
    // Early validation (design §7): throws reach the model as a tool error it
    // can correct this turn, instead of a late provider-factory failure.
    const routeNote = this.router.validateForDispatch(route);
    const record = this.createSubagentThreadRecord({
      profile: options.profile,
      task: typeof input === "string" ? input : "(multimodal task)",
      parentToolCallId: options.parentToolCallId,
      parentToolName: "spawn_agent",
      route,
    });
    if (routeNote) record.toolNotes.push(routeNote);
    this.store.set(record);
    const approval = options.approval ?? record.profile.approval;
    // Admission validation runs before queueing (design §4.2): a request that
    // would block never consumes a queue slot.
    const admissionError = this.admitSubagentProfile(record, approval);
    if (admissionError) {
      this.finalizeSubagentBlocked(record, admissionError, { queueUpdates: true });
      return this.snapshotSubagent(record);
    }
    this.queueSubagentUpdate(record, "queued", undefined, `Queued ${record.nickname} (${record.profile.name})`);
    record.promise = this.dispatchSubagentRun(record, input, cwd, {
      approval,
      abortSignal: options.abortSignal,
      forkContext: options.forkContext,
      queueUpdates: true,
    });
    void record.promise.finally(() => this.store.notifyWaiters(record));
    return this.snapshotSubagent(record);
  }

  async waitSubAgents(options: { agentIds?: string[]; timeoutMs?: number } = {}): Promise<SubagentThreadSnapshot[]> {
    const targets = this.resolveSubagentTargets(options.agentIds);
    if (targets.length === 0) return [];
    const completed = targets.filter((record) => isFinalSubagentStatus(record.status));
    if (completed.length > 0) {
      for (const record of completed) this.store.markDelivered(record.agentId);
      return completed.map((record) => this.snapshotSubagent(record));
    }

    const timeoutMs = normalizeWaitTimeout(options.timeoutMs);
    let waiter: (() => void) | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        waiter = resolve;
        for (const record of targets) {
          record.waiters.add(resolve);
        }
      }).finally(() => {
        if (waiter) {
          for (const record of targets) {
            record.waiters.delete(waiter);
          }
        }
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    const finished = targets.filter((record) => isFinalSubagentStatus(record.status));
    for (const record of finished) this.store.markDelivered(record.agentId);
    return (finished.length > 0 ? finished : targets).map((record) => this.snapshotSubagent(record));
  }

  async sendSubAgentInput(
    agentId: string,
    input: string | ContentPart[],
    cwd: string,
    options: { interrupt?: boolean; parentToolCallId?: string; abortSignal?: AbortSignal } = {},
  ): Promise<SubagentThreadSnapshot> {
    const record = this.store.get(agentId);
    if (!record) {
      throw new Error(`Unknown subagent: ${agentId}`);
    }
    if (record.status === "running" || record.status === "queued") {
      if (!options.interrupt) {
        throw new Error(`Subagent ${agentId} is still running. Call wait_agent first or pass interrupt:true.`);
      }
      record.abortController.abort(new SubagentAbortError(`Subagent ${agentId} interrupted.`, "interrupt"));
      await record.promise?.catch(() => undefined);
      record.abortController = new AbortController();
    }
    if (record.status === "closed") {
      throw new Error(`Subagent ${agentId} is closed.`);
    }

    record.parentToolCallId = options.parentToolCallId ?? record.parentToolCallId;
    record.parentToolName = "send_input";
    record.task = typeof input === "string" ? input : "(multimodal task)";
    record.summary = "";
    record.toolNotes = [];
    record.usage = undefined;
    record.error = undefined;
    record.finalReason = undefined;
    record.deliveredAt = undefined;
    record.updatedAt = Date.now();
    if (record.worktree) {
      // A kept (changed) worktree carries changed/diffStat frozen at the
      // previous terminal outcome; reset them so the finalize after THIS
      // run recomputes instead of reporting stale state.
      record.worktree.changed = undefined;
      record.worktree.diffStat = undefined;
    }
    // A send_input restart is a launch like any other: it goes through the
    // scheduler's dispatch point and is subject to the same admission limits
    // (design §4.1) — batch-resuming team members cannot bypass concurrency caps.
    record.promise = this.dispatchSubagentRun(record, input, cwd, {
      approval: record.profile.approval,
      abortSignal: options.abortSignal,
      queueUpdates: true,
      reuseAgent: true,
    });
    void record.promise.finally(() => this.store.notifyWaiters(record));
    return this.snapshotSubagent(record);
  }

  async closeSubAgent(agentId: string): Promise<SubagentThreadSnapshot> {
    const record = this.store.get(agentId);
    if (!record) {
      throw new Error(`Unknown subagent: ${agentId}`);
    }
    if (!isFinalSubagentStatus(record.status)) {
      record.abortController.abort(new SubagentAbortError(`Subagent ${agentId} closed.`, "user_close"));
      await record.promise?.catch(() => undefined);
    }
    record.status = "closed";
    record.finalReason = record.finalReason ?? "cancelled_user";
    record.updatedAt = Date.now();
    this.queueSubagentUpdate(record, "cancelled", undefined, `${record.nickname} closed`);
    this.store.persist(record);
    this.store.notifyWaiters(record);
    return this.snapshotSubagent(record);
  }

  /**
   * Live (non-final) children only — the delegation-nudge gate
   * (large-task-delegation design §2). listSubAgents() is a grows-only
   * session history (finished + resumed children stay forever), so it must
   * never be used to answer "am I currently delegating?".
   */
  activeSubAgentCount(): number {
    return this.store.activeCount();
  }

  listSubAgents(): SubagentThreadSnapshot[] {
    return this.store.values()
      .filter((record) => !record.workflowInternal)
      .map((record) => this.snapshotSubagent(record));
  }

  async executeWorkflow(
    cwd: string,
    options: {
      script: string;
      args?: unknown;
      parentToolCallId: string;
      abortSignal?: AbortSignal;
      directEmit?: (update: ToolUpdate) => void;
      queueUpdates?: boolean;
      ensureProfileTrusted?: (profile: AgentProfile) => Promise<{ content: string | unknown } | undefined>;
      workflowRunId?: string;
    },
  ): Promise<{ result: { ok: true; value: unknown } | { ok: false; error: string }; agentCount: number; logs: string[]; snapshots: SubagentThreadSnapshot[] }> {
    const profiles = discoverAgentProfiles(cwd, "both").profiles;
    const runRecords: SubagentThreadRecord[] = [];
    const logs: string[] = [];
    let currentWorkflowPhase: string | undefined;

    // Per-run isolation (option C review): a concurrency sub-cap below the
    // global limit so a workflow can't starve interactive subagents.
    const interactiveReserve = 2;
    const globalCap = Math.max(1, this.subagentsConfig.maxActiveSubagents ?? 8);
    const workflowConcurrency = Math.max(1, globalCap - interactiveReserve);
    const gate = new WorkflowConcurrencyGate(workflowConcurrency);

    const dispatchAgent = async (spec: WorkflowAgentSpec): Promise<AgentDispatchResult> => {
      const baseProfile = findAgentProfile(profiles, spec.opts.agentType ?? "default")
        ?? findAgentProfile(profiles, "default");
      if (!baseProfile) return { ok: false, error: "no default subagent profile available" };
      // Workflow agents are readonly-by-default; mode upgrades come only from the
      // profile, never from the script (security invariant).
      const unsupported = baseProfile.mode !== "readonly" && baseProfile.mode !== "write_worktree";
      if (unsupported) return { ok: false, error: `profile "${baseProfile.name}" mode ${baseProfile.mode} not supported` };
      // Default-no-network: unattended orchestration of net-capable agents is new
      // authority in aggregate (option C review), so strip web tools unless the
      // script opts in with agentType pointing at a profile that includes them.
      const profile: AgentProfile = {
        ...baseProfile,
        tools: { ...baseProfile.tools, exclude: [...(baseProfile.tools.exclude ?? []), "web_fetch", "web_search"] },
      };

      let route: ResolvedSubagentRoute;
      let routeNote: string | undefined;
      try {
        route = this.router.resolve(profile, spec.opts.category, {
          model: spec.opts.model,
          effort: parseThinkingLevel(spec.opts.effort),
        });
        // Dispatch-time validation (§7): resolved routes, never script source text.
        routeNote = this.router.validateForDispatch(route);
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) };
      }

      const baseTask = spec.opts.schema !== undefined
        ? appendOutputSchemaInstructions(spec.prompt, spec.opts.schema)
        : spec.prompt;
      const record = this.createSubagentThreadRecord({
        profile,
        task: baseTask,
        parentToolCallId: options.parentToolCallId,
        parentToolName: "run_workflow",
        runId: options.workflowRunId,
        phase: currentWorkflowPhase,
        route,
        workflowInternal: true,
      });
      record.expectsStructuredOutput = spec.opts.schema !== undefined;
      if (routeNote) record.toolNotes.push(routeNote);
      const memberLabel = typeof spec.opts.label === "string" ? spec.opts.label.trim().slice(0, 40) : "";
      if (memberLabel) record.nickname = memberLabel;
      runRecords.push(record);
      this.store.set(record);
      // Project-local profiles pass the same first-use trust gate as
      // spawn_agent: a .bubble/agents profile must never gain a side door
      // into execution just because a script named it (Codex review on #58).
      // Checked AFTER the record exists so a rejected member still shows up
      // in the run's counts/snapshots as blocked instead of vanishing.
      if (options.ensureProfileTrusted) {
        const blocked = await options.ensureProfileTrusted(baseProfile);
        if (blocked) {
          const message = typeof blocked.content === "string" ? blocked.content : `profile "${baseProfile.name}" requires user approval`;
          this.finalizeSubagentBlocked(record, message, { directEmit: options.directEmit, queueUpdates: options.queueUpdates });
          return { ok: false, error: message };
        }
      }
      const admissionError = this.admitSubagentProfile(record, profile.approval);
      if (admissionError) {
        this.finalizeSubagentBlocked(record, admissionError, { directEmit: options.directEmit, queueUpdates: options.queueUpdates });
        return { ok: false, error: admissionError };
      }
      // Leaf-only concurrency permit (option C review M5): held ONLY around this
      // agent's dispatch, never across parallel/pipeline composition.
      await gate.acquire();
      try {
        record.promise = this.dispatchSubagentRun(record, baseTask, cwd, {
          approval: profile.approval,
          abortSignal: options.abortSignal,
          directEmit: options.directEmit,
          queueUpdates: options.queueUpdates,
        });
        await record.promise;
      } finally {
        gate.release();
      }
      this.store.markDelivered(record.agentId);

      if (record.status !== "completed") {
        return { ok: false, error: record.error || `agent ${record.nickname} ended: ${record.finalReason ?? record.status}` };
      }
      if (spec.opts.schema === undefined) {
        return { ok: true, value: record.summary };
      }
      // Structured output: validate, one corrective retry, then fall back to raw.
      // The schema: log lines are the telemetry that decides whether the
      // deferred terminate-style structured-output tool ever gets reopened.
      let validated = validateStructuredSummary(record.summary, spec.opts.schema);
      if (!validated.ok) {
        logs.push(`schema: ${record.nickname} first output failed validation; sending one corrective retry`);
        try {
          await this.sendSubAgentInput(
            record.agentId,
            buildSchemaCorrectionPrompt(spec.opts.schema, record.summary),
            cwd,
            { abortSignal: options.abortSignal },
          );
          await record.promise?.catch(() => undefined);
          validated = validateStructuredSummary(record.summary, spec.opts.schema);
        } catch {
          // resume failed; fall through to raw summary
        }
        logs.push(validated.ok
          ? `schema: ${record.nickname} corrective retry produced valid output`
          : `schema: ${record.nickname} corrective retry still invalid; returning raw summary`);
      }
      return { ok: true, value: validated.ok ? validated.value : record.summary };
    };

    const result = await runWorkflow({
      script: options.script,
      args: options.args,
      dispatchAgent,
      onLog: (message) => logs.push(message),
      onPhase: (title) => {
        currentWorkflowPhase = title;
        logs.push(`— phase: ${title} —`);
      },
      budget: {
        // The ledger is pure accounting (no pool limit); scripts see an
        // unlimited budget unless a future host contract reintroduces one.
        total: null,
        spent: () => runRecords.reduce((sum, r) => sum + (r.usage ? r.usage.promptTokens + r.usage.completionTokens : 0), 0),
        remaining: () => Number.POSITIVE_INFINITY,
      },
      signal: options.abortSignal,
    });

    return {
      result,
      agentCount: runRecords.length,
      logs,
      snapshots: runRecords.map((record) => this.snapshotSubagent(record)),
    };
  }

  markSubagentDelivered(agentId: string): void {
    this.store.markDelivered(agentId);
  }

  private snapshotSubagent(record: SubagentThreadRecord): SubagentThreadSnapshot {
    const snapshot = snapshotSubagentThread(record);
    if (record.status === "queued") {
      const queuePosition = this.scheduler.queuePosition(record.agentId);
      if (queuePosition !== undefined) return { ...snapshot, queuePosition };
    }
    return snapshot;
  }

  /** Returns the blocking diagnostic message when the profile cannot run, else undefined. */
  private admitSubagentProfile(record: SubagentThreadRecord, approval: "fail" | "disabled"): string | undefined {
    const diagnostics = validateAgentProfileTools(this.parent.allTools(), record.profile, approval);
    const blocking = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (blocking.length === 0) return undefined;
    return blocking.map((diagnostic) => diagnostic.message).join("\n");
  }

  /**
   * Background children (queueUpdates) get their results ingested before the
   * parent's next inference turn (design §5); foreground children (team,
   * legacy task) deliver through their tool result instead.
   */
  private maybeEnqueueIngestion(
    record: SubagentThreadRecord,
    options: { queueUpdates?: boolean },
  ): void {
    if (options.queueUpdates) {
      this.resultIntegrator.enqueue(record.agentId);
    }
  }

  private finalizeSubagentBlocked(
    record: SubagentThreadRecord,
    error: string,
    emitOptions: { directEmit?: (update: ToolUpdate) => void; queueUpdates?: boolean },
  ): void {
    record.status = "blocked";
    record.finalReason = "blocked";
    record.error = error;
    record.updatedAt = Date.now();
    this.emitSubagentLifecycle(record, emitOptions, "blocked", undefined, error);
    this.store.persist(record);
    this.store.notifyWaiters(record);
  }

  private dispatchSubagentRun(
    record: SubagentThreadRecord,
    input: string | ContentPart[],
    cwd: string,
    options: {
      approval: "fail" | "disabled";
      abortSignal?: AbortSignal;
      forkContext?: boolean;
      directEmit?: (update: ToolUpdate) => void;
      queueUpdates?: boolean;
      reuseAgent?: boolean;
    },
  ): Promise<void> {
    record.status = "queued";
    record.updatedAt = Date.now();
    const queueSignal = composeAbortSignals([options.abortSignal, record.abortController.signal]);
    return this.scheduler.dispatch({
      agentId: record.agentId,
      category: record.category,
      signal: queueSignal,
      run: (ctx) => this.runSubagentThread(record, input, cwd, { ...options, attempt: ctx.attempt }),
      onCancelledWhileQueued: (reason) => {
        record.status = "cancelled";
        record.finalReason = classifySubagentAbortReason(reason, options.abortSignal);
        record.error = reason instanceof Error ? reason.message : reason ? String(reason) : "Cancelled while queued.";
        record.updatedAt = Date.now();
        // This path is NOT only "run never started" — a 429/transport
        // failure re-queues the entry with the abort listener re-armed, so
        // an abort during backoff lands here AFTER attempt 1 already ran
        // (worktree created, SubagentStart fired). Reclaim is therefore a
        // real leak fix here, and an open Start pair must be closed too
        // (design §9): only when no Start ever fired is skipping Stop right.
        if (record.hookStopPending) {
          void this.runSubagentLifecycleHookFor(record, cwd, "SubagentStop", record.status, record.error);
        }
        this.reclaimWorktree(record);
        this.emitSubagentLifecycle(record, options, "cancelled", undefined, record.error);
        this.store.persist(record);
        this.store.notifyWaiters(record);
        this.maybeEnqueueIngestion(record, options);
      },
      onRateLimitExhausted: (attempts) => {
        record.status = "failed";
        record.finalReason = "rate_limited_exhausted";
        record.error = `Provider rate limit persisted after ${attempts} attempts.`;
        record.updatedAt = Date.now();
        // Reclaim before persist so the handoff note lands in the
        // persisted toolNotes.
        this.reclaimWorktree(record);
        void this.runSubagentLifecycleHookFor(record, cwd, "SubagentStop", record.status, record.error);
        this.emitSubagentLifecycle(record, options, "failed", undefined, record.error);
        this.store.persist(record);
        this.store.notifyWaiters(record);
        this.maybeEnqueueIngestion(record, options);
      },
      onTransportRetryExhausted: (attempts) => {
        record.status = "failed";
        // failed_transient stays resumable, so the parent can still send_input
        // to recover the child with its context intact.
        record.finalReason = "failed_transient";
        record.error = `Provider transport error persisted after ${attempts} attempts.`;
        record.updatedAt = Date.now();
        this.reclaimWorktree(record);
        void this.runSubagentLifecycleHookFor(record, cwd, "SubagentStop", record.status, record.error);
        this.emitSubagentLifecycle(record, options, "failed", undefined, record.error);
        this.store.persist(record);
        this.store.notifyWaiters(record);
        this.maybeEnqueueIngestion(record, options);
      },
    });
  }

  private emitSubagentLifecycle(
    record: SubagentThreadRecord,
    options: { directEmit?: (update: ToolUpdate) => void; queueUpdates?: boolean },
    status: ToolUpdate["status"],
    event?: AgentEvent,
    message?: string,
  ): void {
    const update = this.buildSubagentUpdate(record, status, event, message);
    options.directEmit?.(update);
    if (options.queueUpdates) {
      this.pendingUpdates.push({ id: record.parentToolCallId, name: record.parentToolName, update });
      this.wakeSubagentUpdateWaiters();
    }
  }

  /** Lets a blocked tool-execution loop drain freshly queued subagent updates. */
  private wakeSubagentUpdateWaiters(): void {
    for (const wake of this.updateWakers) wake();
  }

  private async runSubagentLifecycleHookFor(
    record: SubagentThreadRecord,
    cwd: string,
    eventName: "SubagentStart" | "SubagentStop",
    status?: string,
    error?: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    // Pairing state (design §9), tracked at this single choke point —
    // every Start/Stop passes through here, so no call site can desync it.
    // Set synchronously, before the await, to stay ordered with callers.
    record.hookStopPending = eventName === "SubagentStart";
    try {
      await this.parent.runExternalHook({
        eventName,
        cwd,
        runId: record.runId,
        target: record.profile.name,
        payload: {
          agentId: record.agentId,
          nickname: record.nickname,
          profile: record.profile.name,
          status,
          error,
        },
      }, abortSignal);
    } catch {
      // Subagent lifecycle hooks are observe-only; never fail the subagent.
      // Observe-only extends to the RESULT, not just errors: the returned
      // events and modelContext are dropped ON PURPOSE, matching every other
      // terminal/lifecycle event (Stop, StopFailure, SessionStart/End).
      // Injecting them would push each child's start/stop hook output into
      // the parent transcript, once per child in a fan-out. Do not "fix"
      // this by wiring the result into injectHookModelContext.
    }
  }

  private createSubagentThreadRecord(options: {
    profile: AgentProfile;
    task: string;
    runId?: string;
    agentId?: string;
    parentToolCallId: string;
    parentToolName: string;
    nickname?: string;
    route?: ResolvedSubagentRoute;
    workflowInternal?: boolean;
    phase?: string;
  }): SubagentThreadRecord {
    const now = Date.now();
    const nickname = options.nickname ?? assignAgentNickname(options.profile, this.activeSubagentNicknames());
    return {
      agentId: options.agentId ?? randomUUID(),
      runId: options.runId ?? randomUUID(),
      nickname,
      profile: options.profile,
      category: options.route?.category,
      phase: options.phase,
      route: options.route,
      workflowInternal: options.workflowInternal,
      parentToolCallId: options.parentToolCallId,
      parentToolName: options.parentToolName,
      status: "queued",
      task: options.task,
      summary: "",
      toolNotes: [],
      createdAt: now,
      updatedAt: now,
      abortController: new AbortController(),
      waiters: new Set(),
    };
  }

  private runSubagentThread(
    record: SubagentThreadRecord,
    input: string | ContentPart[],
    cwd: string,
    options: ChildRunOptions,
  ): Promise<SubagentRunOutcome> {
    return this.childRunner.run(record, input, cwd, options);
  }

  private async createSubAgentInstance(
    record: SubagentThreadRecord,
    tools: ToolRegistryEntry[],
    cwd: string,
    forkContext?: boolean,
  ): Promise<ChildAgentLike> {
    let childCwd = cwd;
    let childMode: PermissionMode = "plan";
    if (record.profile.mode === "write_worktree") {
      // Write children work in a runtime-allocated worktree with fresh tool
      // instances bound to it (design §8): the parent tree is never touched,
      // and the tools' own workspace fence enforces containment in code.
      // NOTE: record.worktree must be assigned before anything below can
      // throw — ChildRunner's failure path reclaims it off the record.
      if (!record.worktree) {
        record.worktree = createSubagentWorktree(cwd, record.agentId);
      }
      childCwd = record.worktree.path;
      childMode = "default";
      tools = createWorktreeChildTools(childCwd, record.profile.tools.include);
    } else {
      // Readonly children share the parent's tool instances; isolate the only
      // one with mutable file state (read → its FileStateTracker) so concurrent
      // fan-out members never race shared tool state (design v2 §2).
      tools = isolateReadonlyChildFileTools(tools);
    }
    const childToolNames = tools.map((tool) => tool.name);
    const route = record.route ?? {
      providerId: this.parent.providerId,
      model: this.parent.apiModel,
      thinkingLevel: this.parent.thinkingLevel,
      inherited: true,
    };
    const provider = await this.resolveProviderForRoute(route);
    const childSystemPrompt = buildSystemPrompt({
      agentName: "Bubble",
      configuredProvider: route.providerId || "none",
      configuredModel: route.model || "none",
      configuredModelId: route.providerId && route.model ? `${route.providerId}:${route.model}` : route.model || "none",
      thinkingLevel: route.thinkingLevel,
      mode: childMode,
      workingDir: childCwd,
      ...buildToolPromptOptions(tools),
      memoryPrompt: childToolNames.some((name) => name === "memory")
        ? this.parent.memoryPrompt
        : undefined,
      agentProfilePrompt: [
        `You are subagent ${record.nickname}. Your agent profile is ${record.profile.name}.`,
        record.profile.mode === "write_worktree"
          ? [
            "You work inside an isolated git worktree; the parent reviews your diff after you finish.",
            "Make your changes, verify them (run tests where possible), and end with a handoff that lists the files you changed and how you verified them.",
            "Do not commit, push, or touch anything outside this worktree.",
          ].join(" ")
          : "",
        record.profile.prompt,
      ].filter(Boolean).join("\n\n"),
    });
    // Cross-restart resume (design §7): rebuild the child from its persisted
    // history — including its original system prompt — so send_input continues
    // with context intact. Consumed here so a later run does not re-seed it.
    const resumeMessages = record.messages && record.messages.length > 0
      ? record.messages.map((message) => ({ ...message }))
      : undefined;
    if (resumeMessages) record.messages = undefined;
    return this.parent.createChild({
      provider,
      providerId: route.providerId,
      model: route.model,
      tools,
      thinkingLevel: route.thinkingLevel,
      mode: childMode,
      maxTurns: record.profile.maxTurns,
      budgetSource: { runId: record.runId, subAgentId: record.agentId },
      systemPrompt: childSystemPrompt,
      subAgentId: record.agentId,
      resumeMessages,
      forkContext,
    });
  }

  private async resolveProviderForRoute(route: ResolvedSubagentRoute): Promise<Provider> {
    if (!route.providerId || route.providerId === this.parent.providerId) {
      return this.parent.provider;
    }
    if (!this.parent.providerFactory) {
      throw new Error([
        `Subagent route requires provider "${route.providerId}" for model "${route.model}",`,
        `but the parent agent only has provider "${this.parent.providerId || "none"}" and no provider factory is configured.`,
      ].join(" "));
    }
    return this.parent.providerFactory(route);
  }

  private buildSubagentUpdate(
    record: SubagentThreadRecord,
    status: ToolUpdate["status"],
    event?: AgentEvent,
    message?: string,
  ): ToolUpdate {
    return {
      type: "subagent_update",
      parentToolCallId: record.parentToolCallId,
      runId: record.runId,
      subAgentId: record.agentId,
      agentName: record.profile.name,
      nickname: record.nickname,
      category: record.category,
      route: record.route,
      status,
      childEvent: event,
      summaryDelta: event?.type === "text_delta" ? event.content : undefined,
      toolName: "name" in (event ?? {}) ? (event as any).name : undefined,
      toolCallId: "id" in (event ?? {}) ? (event as any).id : undefined,
      message,
      metadata: {
        kind: "subagent",
        runId: record.runId,
        mode: record.parentToolName === "run_workflow" ? "workflow" : "single",
        subagents: [{
          subAgentId: record.agentId,
          runId: record.runId,
          agentName: record.profile.name,
          nickname: record.nickname,
          category: record.category,
          phase: record.phase,
          route: record.route,
          status,
          profileSource: record.profile.source,
          task: record.task,
          summary: record.summary,
          toolNotes: record.toolNotes,
          usage: record.usage,
          error: record.error,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }],
      },
    };
  }

  private queueSubagentUpdate(
    record: SubagentThreadRecord,
    status: ToolUpdate["status"],
    event?: AgentEvent,
    message?: string,
  ): void {
    this.pendingUpdates.push({
      id: record.parentToolCallId,
      name: record.parentToolName,
      update: this.buildSubagentUpdate(record, status, event, message),
    });
    this.wakeSubagentUpdateWaiters();
  }

  /** Queued background-child updates for Agent.run() to emit. */
  drainToolUpdates(): AgentEvent[] {
    return this.pendingUpdates.splice(0, this.pendingUpdates.length)
      .map((pending) => ({
        type: "tool_update" as const,
        id: pending.id,
        name: pending.name,
        update: pending.update,
      }));
  }

  private activeSubagentNicknames(): string[] {
    return this.store.active().map((record) => record.nickname);
  }

  private resolveSubagentTargets(agentIds?: string[]): SubagentThreadRecord[] {
    if (!agentIds || agentIds.length === 0) {
      return this.store.values().filter((record) => record.status !== "closed" && !record.workflowInternal);
    }
    return agentIds.map((id) => {
      const record = this.store.get(id);
      if (!record) {
        throw new Error(`Unknown subagent: ${id}`);
      }
      return record;
    });
  }
}

export function isFinalSubagentStatus(status: SubagentThreadRecord["status"]): boolean {
  return status === "completed"
    || status === "failed"
    || status === "blocked"
    || status === "cancelled"
    || status === "closed";
}

export function normalizeWaitTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30_000;
  return Math.max(100, Math.min(3_600_000, Math.floor(value)));
}

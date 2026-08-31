/**
 * Bubble SDK — the programmatic embedding surface for external hosts.
 *
 * Two layers:
 *  1. `BubbleSdk` — a high-level facade that owns config/provider resolution and
 *     assembles a full agent turn (tools, approvals, questions, plan mode, MCP,
 *     skills, hooks, session persistence) behind a single `runTurn()` async
 *     iterator of `AgentEvent`s. This is what a host like an Electron app should
 *     consume: wire the three interaction callbacks (approval / question / plan)
 *     to its own UI and map the event stream to its own message format.
 *  2. Curated re-exports of the underlying building blocks, for hosts that need
 *     to assemble a custom loop the facade doesn't cover.
 *
 * Runs under plain Node (>=20); nothing here touches the TUI layer.
 */

import os from "node:os";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { Agent, AgentAbortError } from "../agent.js";
import { AgentRunInputQueue } from "../agent/input-controller.js";
import {
  SessionTurnCoordinator,
  type SessionTurnReservation,
} from "./session-turn-coordinator.js";
import { ReplayEventLog } from "./replay-event-log.js";
import { SessionManager, type SessionSummary } from "../session.js";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import { BashAllowlist } from "../approval/session-cache.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import { createAllTools, buildToolPromptOptions, type PlanController } from "../tools/index.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { FileStateTracker } from "../tools/file-state.js";
import { BudgetLedger } from "../agent/budget-ledger.js";
import { UserConfig } from "../config.js";
import { ProviderRegistry, encodeModel, decodeModel, displayModel } from "../provider-registry.js";
import { createProviderInstance } from "../provider.js";
import type { ResolvedSubagentRoute } from "../agent/categories.js";
import { getDefaultThinkingLevel } from "../variant/variant-resolver.js";
import { QuestionController, type QuestionAnswer, type QuestionRequest } from "../question/controller.js";
import { assertProviderModelAllowed } from "../provider-model-policy.js";
import { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import type { SkillSummary } from "../skills/types.js";
import { GoalStore } from "../goal/store.js";
import { McpManager } from "../mcp/manager.js";
import { loadMcpConfig } from "../mcp/config.js";
import { ExternalHookController } from "../hooks/controller.js";
import { buildMemoryPrompt } from "../memory/store.js";
import { calculateUsageCost } from "../model-pricing.js";
import { purgeUnsafeMemorySources } from "../memory/session-policy.js";
import { recordMemoryCitations } from "../memory/usage.js";
import type {
  AgentEvent,
  AgentRunInput,
  ContentPart,
  Message,
  PermissionMode,
  Provider,
  ThinkingLevel,
  ToolRegistryEntry,
} from "../types.js";

// ── Facade types ───────────────────────────────────────────────────────────

export interface BubbleSdkOptions {
  /** Fallback working directory for sessions created without an explicit cwd. */
  defaultCwd?: string;
  /**
   * Load MCP servers from user/project settings (default true). Hermetic hosts
   * (evals, tests) set false so runs never depend on ambient MCP config.
   */
  mcp?: boolean;
}

/** Resolved turn configuration, reported via onStart (e.g. for a host's system-init event). */
export interface TurnStartInfo {
  providerId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  mode: PermissionMode;
  tools: string[];
  skills: string[];
}

/** Host-side interaction callbacks for one turn. All optional; missing handlers fail safe (reject). */
export interface TurnHandlers {
  /**
   * Tool call needs user permission (bash / edit / write / …). When the turn is
   * aborted, any still-pending request auto-resolves to reject — the host's
   * promise may settle later and is then ignored.
   */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Agent asked the user a structured question. Return answers, or null to decline. */
  onQuestion?: (req: QuestionRequest) => Promise<QuestionAnswer[] | null>;
  /** Plan-mode proposal. Return true to approve executing the plan. */
  onPlanApproval?: (planMarkdown: string) => Promise<boolean>;
  /** Fired once per turn after provider/model/tools are resolved, before the first event. */
  onStart?: (info: TurnStartInfo) => void;
}

export interface RunTurnOptions extends TurnHandlers {
  /** Plain text, or content parts (text + base64 images) for attachments. */
  prompt: string | ContentPart[];
  /** "provider:model" or bare model id (resolved against the default provider). */
  model?: string;
  mode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  /**
   * Extra text appended to the built system prompt. Lets hosts (and the eval
   * harness) A/B prompt variants without forking the prompt builder.
   */
  appendSystemPrompt?: string;
  /**
   * Creates the provider instance for a subagent route whose provider differs
   * from the turn's provider (e.g. spawn_agent with `model: "provider:model"`).
   * When omitted the SDK builds a default factory over its own registry —
   * same semantics as the TUI's createProviderForRoute (OAuth prepare, then
   * configured+enabled+keyed profile lookup). Pass your own to override.
   */
  providerFactory?: (route: ResolvedSubagentRoute) => Provider | Promise<Provider>;
  signal?: AbortSignal;
}

export interface SdkSessionRef {
  id: string;
  cwd: string;
}

export interface SdkSessionRunState {
  /** A turn owns the session slot, including setup and teardown. */
  active: boolean;
  queuedTurns: number;
  pendingSteers: number;
  phase: "idle" | "reserved" | "starting" | "active" | "stopping" | "deleted";
}

export type SdkSteerOutcome = Extract<AgentEvent, {
  type: "input_applied" | "input_queued" | "input_rejected";
}>;

export type SdkSteerResult =
  | {
      accepted: true;
      disposition: "steered";
      input: AgentRunInput;
      outcome: Promise<SdkSteerOutcome>;
    }
  | {
      accepted: true;
      disposition: "queued";
      input: AgentRunInput;
      turnId: string;
      outcome: Promise<SdkSteerOutcome>;
    }
  | {
      accepted: false;
      disposition: "rejected";
      reason: "unknown_session" | "session_deleted" | "ownership_conflict";
    };

export interface SdkSessionEvent {
  sequence: number;
  sessionId: string;
  turnId: string;
  event: AgentEvent;
  /**
   * Present only on the synthesized record that ends a turn abnormally.
   * Replay subscribers use it to tell "turn failed" from "turn still running";
   * the per-turn runTurn() iterator instead surfaces the thrown error.
   */
  terminal?: SdkSessionTerminal;
}

export interface SdkSessionTerminal {
  kind: "failed" | "cancelled";
  message: string;
}

export interface SdkStopOptions {
  /** Match Claude-style interruption: queued messages survive by default. */
  cancelQueued?: boolean;
}

export interface SdkSessionHandle extends SdkSessionRef {
  /** Events from every turn in this session. Opening another handle reconnects from sequence 1. */
  readonly events: AsyncIterable<SdkSessionEvent>;
  /** Reconnect after the last sequence the host durably processed. */
  eventsFrom(afterSequence: number): AsyncIterable<SdkSessionEvent>;
  send(options: RunTurnOptions): AsyncGenerator<AgentEvent>;
  steer(content: string): SdkSteerResult;
  stop(options?: SdkStopOptions): number;
  close(): void;
}

interface PendingSteerOutcome {
  input: AgentRunInput;
  promise: Promise<SdkSteerOutcome>;
  resolve(outcome: SdkSteerOutcome): void;
}

interface SdkTurnRuntime {
  sessionId: string;
  ownerKey: string;
  reservation: SessionTurnReservation;
  inputController: AgentRunInputQueue;
  outcomes: Map<string, PendingSteerOutcome>;
  options: RunTurnOptions;
  events: ReplayEventLog<AgentEvent>;
}

// ── Facade ─────────────────────────────────────────────────────────────────

export class BubbleSdk {
  readonly userConfig = new UserConfig();
  readonly registry = new ProviderRegistry(this.userConfig);

  private readonly defaultCwd: string;
  private readonly mcpEnabled: boolean;
  private readonly cwdBySession = new Map<string, string>();
  private readonly bashAllowlists = new Map<string, BashAllowlist>();
  private readonly turnCoordinator = new SessionTurnCoordinator();
  private readonly turnRuntimes = new Map<string, SdkTurnRuntime>();
  private readonly lastTurnOptions = new Map<string, Omit<RunTurnOptions, "prompt" | "signal">>();
  private readonly mcpToolsByCwd = new Map<string, Promise<ToolRegistryEntry[]>>();
  private nextTurnInputPrefix = 0;
  private nextDetachedInputId = 0;
  /** id -> {cwd,file} rebuilt from disk so sessions survive host restarts. */
  private sessionIndex = new Map<string, { cwd: string; file: string }>();

  constructor(options: BubbleSdkOptions = {}) {
    this.defaultCwd = options.defaultCwd || process.env.BUBBLE_CWD || os.homedir();
    this.mcpEnabled = options.mcp !== false;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  listSessions(): SessionSummary[] {
    const sessions = SessionManager.listAllSessions().filter((session) => !this.turnCoordinator.isDeleted(session.name));
    this.sessionIndex = new Map(
      sessions.map((s) => [s.name, { cwd: s.cwd ?? s.cwdLabel ?? this.defaultCwd, file: s.file }]),
    );
    return sessions;
  }

  createSession(options: { cwd?: string; id?: string } = {}): SdkSessionRef {
    const cwd = options.cwd || this.defaultCwd;
    const id = options.id || `sdk-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    this.turnCoordinator.revive(id);
    const manager = SessionManager.create(cwd, sessionFileName(id));
    processSessionLocations.set(id, { ownerKey: manager.getSessionFile(), cwd });
    this.cwdBySession.set(id, cwd);
    return { id, cwd };
  }

  openSession(sessionId: string): SdkSessionHandle {
    const resolved = this.resolveSession(sessionId);
    if (!resolved) throw new Error(`Unknown session: ${sessionId}`);
    const ownerKey = resolved.manager.getSessionFile();
    const eventLog = sessionEventLogFor(ownerKey);
    const closed = new AbortController();
    return {
      id: sessionId,
      cwd: resolved.cwd,
      events: eventLog.iterate({ signal: closed.signal }),
      eventsFrom: (afterSequence) => eventLog.iterate({
        from: Math.max(0, afterSequence),
        signal: closed.signal,
      }),
      send: (options) => this.runTurn(sessionId, options),
      steer: (content) => this.steer(sessionId, content),
      stop: (options) => this.stop(sessionId, options),
      close: () => closed.abort(),
    };
  }

  getHistory(sessionId: string): Message[] {
    if (this.turnCoordinator.isDeleted(sessionId)) return [];
    return this.resolveSession(sessionId)?.manager.getMessages() ?? [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    const owner = this.ownerForSession(sessionId);
    if (owner && owner !== this) return owner.deleteSession(sessionId);
    const resolved = this.resolveSession(sessionId);
    for (const runtime of this.runtimesForSession(sessionId)) runtime.inputController.closePendingInputs();
    await this.turnCoordinator.delete(sessionId);
    if (resolved) rmSync(resolved.manager.getSessionFile(), { force: true });
    this.cwdBySession.delete(sessionId);
    this.bashAllowlists.delete(sessionId);
    this.lastTurnOptions.delete(sessionId);
    this.sessionIndex.delete(sessionId);
    processSessionLocations.delete(sessionId);
    if (resolved) {
      releaseSessionEventLog(resolved.manager.getSessionFile());
      releaseProcessOwner(resolved.manager.getSessionFile(), this);
    }
  }

  /** Interrupt the active turn. Queued turns survive unless cancelQueued is true. */
  stop(sessionId: string, options: SdkStopOptions = {}): number {
    const owner = this.ownerForSession(sessionId);
    if (owner && owner !== this) return owner.stop(sessionId, options);
    const current = this.turnCoordinator.getCurrent(sessionId);
    const runtime = current ? this.turnRuntimes.get(current.id) : undefined;
    runtime?.inputController.closePendingInputs();
    const stopped = this.turnCoordinator.stopCurrent(sessionId);
    return stopped + (options.cancelQueued ? this.turnCoordinator.clearQueue(sessionId) : 0);
  }

  /** Cancel queued turns without interrupting the turn that owns the session slot. */
  clearQueue(sessionId: string): number {
    const owner = this.ownerForSession(sessionId);
    if (owner && owner !== this) return owner.clearQueue(sessionId);
    return this.turnCoordinator.clearQueue(sessionId);
  }

  getSessionRunState(sessionId: string): SdkSessionRunState {
    const owner = this.ownerForSession(sessionId);
    if (owner && owner !== this) return owner.getSessionRunState(sessionId);
    const state = this.turnCoordinator.getState(sessionId);
    const current = this.turnCoordinator.getCurrent(sessionId);
    const runtime = current ? this.turnRuntimes.get(current.id) : undefined;
    return {
      active: state.active,
      queuedTurns: state.queued,
      pendingSteers: runtime?.outcomes.size ?? 0,
      phase: state.phase,
    };
  }

  /**
   * Add text to the turn that currently owns the session slot. Every accepted
   * input exposes an outcome promise, independent of event-stream consumption.
   */
  steer(sessionId: string, content: string): SdkSteerResult {
    if (this.turnCoordinator.isDeleted(sessionId)) {
      return { accepted: false, disposition: "rejected", reason: "session_deleted" };
    }
    const owner = this.ownerForSession(sessionId);
    if (owner && owner !== this) return owner.steer(sessionId, content);
    const resolved = this.resolveSession(sessionId);
    if (!resolved) {
      return { accepted: false, disposition: "rejected", reason: "unknown_session" };
    }
    const current = this.turnCoordinator.getCurrent(sessionId);
    const runtime = current ? this.turnRuntimes.get(current.id) : undefined;
    if (runtime) {
      const input = runtime.inputController.tryEnqueue(content);
      if (input) {
        const pending = pendingSteerOutcome(input);
        runtime.outcomes.set(input.id, pending);
        return { accepted: true, disposition: "steered", input, outcome: pending.promise };
      }
    }
    return this.queueDetachedInput(sessionId, content, resolved);
  }

  enqueueTurn(sessionId: string, options: RunTurnOptions): AsyncGenerator<AgentEvent> {
    return this.runTurn(sessionId, options);
  }

  queueTurn(sessionId: string, options: RunTurnOptions): AsyncGenerator<AgentEvent> {
    return this.enqueueTurn(sessionId, options);
  }

  // ── Discovery (composer pickers) ─────────────────────────────────────────

  listSkills(cwd?: string): SkillSummary[] {
    const registry = new SkillRegistry({
      cwd: cwd || this.defaultCwd,
      skillPaths: this.userConfig.getSkillPaths(),
      disabledSkills: this.userConfig.getDisabledSkills(),
    });
    return registry.summaries();
  }

  /** Configured providers + default model, for a host's model picker. */
  getModelConfig(): {
    defaultProviderId: string;
    defaultModel: string;
    providers: Array<{ id: string; baseURL?: string; hasApiKey: boolean }>;
  } {
    const configured = this.registry.getConfigured().filter((p) => p.enabled);
    return {
      defaultProviderId: this.registry.getDefault()?.id ?? "",
      defaultModel: this.userConfig.getDefaultModel() ?? "",
      providers: configured.map((p) => ({ id: p.id, baseURL: p.baseURL, hasApiKey: Boolean(p.apiKey) })),
    };
  }

  // ── The turn ─────────────────────────────────────────────────────────────

  /**
   * Reserve and start a session turn immediately. Execution is driven by the
   * SDK's own pump, not by consumption of the returned iterator: the iterator
   * is a replay subscription, so a host may drop it (or reconnect later via
   * `openSession`) without stalling or cancelling the turn. Cancel with
   * `stop()`, the options signal, or `deleteSession()`.
   */
  runTurn(sessionId: string, options: RunTurnOptions): AsyncGenerator<AgentEvent> {
    const resolved = this.resolveSession(sessionId);
    if (!resolved) throw new Error(`Unknown session: ${sessionId}`);
    const ownerKey = resolved.manager.getSessionFile();
    const owner = processSessionOwners.get(ownerKey);
    if (owner && owner !== this) return owner.runTurn(sessionId, options);
    claimProcessOwner(ownerKey, this);
    try {
      const runtime = this.startOwnedTurn(sessionId, options, resolved, ownerKey);
      return runtime.events.iterate();
    } catch (error) {
      // A synchronous reserve() failure (e.g. pre-aborted signal) must not
      // leave this SDK pinned as process owner of a session it never ran.
      if (!this.turnCoordinator.getState(sessionId).active) {
        releaseProcessOwner(ownerKey, this);
      }
      throw error;
    }
  }

  private startOwnedTurn(
    sessionId: string,
    options: RunTurnOptions,
    resolved: { manager: SessionManager; cwd: string },
    ownerKey: string,
  ): SdkTurnRuntime {
    const reservation = this.turnCoordinator.reserve(sessionId, options.signal);
    const runtime: SdkTurnRuntime = {
      sessionId,
      ownerKey,
      reservation,
      inputController: new AgentRunInputQueue(`sdk-turn-${++this.nextTurnInputPrefix}`),
      outcomes: new Map(),
      options,
      events: new ReplayEventLog<AgentEvent>(),
    };
    this.lastTurnOptions.set(sessionId, inheritableTurnOptions(options));
    this.turnRuntimes.set(reservation.id, runtime);
    void this.pumpTurn(runtime, resolved);
    return runtime;
  }

  private async pumpTurn(
    runtime: SdkTurnRuntime,
    resolved: { manager: SessionManager; cwd: string },
  ): Promise<void> {
    let failure: unknown;
    try {
      for await (const event of this.runReservedTurn(runtime, runtime.options, resolved)) {
        runtime.events.append(event);
        this.publishSessionEvent(runtime, event);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (failure !== undefined) {
        // The session-level log never closes per turn, so replay subscribers
        // need an explicit terminal record — otherwise a failed turn is
        // indistinguishable from one that is still running.
        this.publishSessionEvent(
          runtime,
          { type: "turn_end", willContinue: false },
          {
            kind: failure instanceof AgentAbortError ? "cancelled" : "failed",
            message: failure instanceof Error ? failure.message : String(failure),
          },
        );
      }
      runtime.events.close(failure);
      if (this.turnRuntimes.get(runtime.reservation.id) === runtime) {
        this.turnRuntimes.delete(runtime.reservation.id);
      }
      if (!this.turnCoordinator.getState(runtime.sessionId).active) {
        releaseProcessOwner(runtime.ownerKey, this);
      }
    }
  }

  private async *runReservedTurn(
    runtime: SdkTurnRuntime,
    options: RunTurnOptions,
    resolved: { manager: SessionManager; cwd: string },
  ): AsyncGenerator<AgentEvent> {
    const { sessionId, reservation, inputController } = runtime;
    const { manager: session, cwd } = resolved;
    const mode: PermissionMode = options.mode ?? "default";
    const abortSignal = reservation.signal;

    let agentRef: Agent | undefined;
    let streamCompleted = false;
    const hookController = new ExternalHookController({ cwd, sessionId });
    // Settles as reject the moment the turn aborts, so a tool blocked on a
    // host approval (or question) can never hang the abort path.
    const abortedDecision = new Promise<ApprovalDecision>((resolve) => {
      const decide = () => resolve({ action: "reject", feedback: "Turn aborted" });
      if (abortSignal.aborted) decide();
      else abortSignal.addEventListener("abort", decide, { once: true });
    });
    const approvalController = new PermissionAwareApprovalController({
      getMode: () => agentRef?.mode ?? mode,
      handlerRef: {
        current: (req: ApprovalRequest) =>
          options.onApproval
            ? Promise.race([options.onApproval(req), abortedDecision])
            : Promise.resolve<ApprovalDecision>({
                action: "reject",
                feedback: "Host provided no approval handler",
              }),
      },
      bashAllowlist: this.bashAllowlistFor(sessionId),
      cwd,
      externalHooks: hookController,
    });
    const fileStateTracker = new FileStateTracker(cwd);
    const planController: PlanController = {
      getMode: () => agentRef?.mode ?? mode,
      requestApproval: async (plan: string) => {
        const approved = options.onPlanApproval
          ? await awaitWithAbort(options.onPlanApproval(plan), abortSignal)
          : false;
        if (approved) {
          agentRef?.setMode("default");
          return { action: "approve" as const, plan };
        }
        return { action: "reject" as const, reason: "Plan rejected by host" };
      },
      setMode: (m) => agentRef?.setMode(m),
    };
    const questionController = new QuestionController();
    const unsubscribeQuestions = questionController.subscribe((event) => {
      if (event.type !== "asked") return;
      const request = event.request;
      if (!options.onQuestion) {
        questionController.reject(request.id);
        return;
      }
      options.onQuestion(request).then(
        (answers) =>
          answers ? questionController.reply(request.id, answers) : questionController.reject(request.id),
        () => questionController.reject(request.id),
      );
    });
    abortSignal.addEventListener("abort", () => questionController.rejectAll(), { once: true });

    try {
      await reservation.waitForStart();
      const skillRegistry = new SkillRegistry({
        cwd,
        skillPaths: this.userConfig.getSkillPaths(),
        disabledSkills: this.userConfig.getDisabledSkills(),
      });
      const tools = createAllTools(cwd, skillRegistry, {
        approvalController,
        fileStateTracker,
        planController,
        questionController,
        goalStore: new GoalStore(),
        checkpoints: () => session.getCheckpoints(),
      });
      tools.push(...(await awaitWithAbort(this.mcpToolsFor(cwd), abortSignal)));
      throwAbortSignal(abortSignal);

      const promptCacheKey = session.getOrCreatePromptCacheKey();
      if (!this.turnCoordinator.isDeleted(sessionId)) {
        session.updateMetadata({ cwd }); // recoverable by cwd after host restart
      }
      const { provider, providerId, model } = this.resolveProvider(promptCacheKey, options.model);
      const thinkingLevel =
        options.thinkingLevel ??
        this.userConfig.getDefaultThinkingLevel() ??
        getDefaultThinkingLevel(providerId, decodeModel(model).modelId);
      // Same ordering as the TUI: the provenance gate must run before memories
      // enter the system prompt.
      purgeUnsafeMemorySources(cwd);
      const memoryPrompt = buildMemoryPrompt(cwd);
      const builtSystemPrompt = buildSystemPrompt({
        agentName: "Bubble",
        configuredProvider: providerId || "none",
        configuredModel: model ? displayModel(model) : "none",
        configuredModelId: model || "none",
        thinkingLevel,
        mode,
        workingDir: cwd,
        ...buildToolPromptOptions(tools.filter((t) => !t.deferred)),
        memoryPrompt,
      });
      const systemPrompt = options.appendSystemPrompt
        ? `${builtSystemPrompt}\n\n${options.appendSystemPrompt.trim()}`
        : builtSystemPrompt;

      const agent = new Agent({
        provider,
        providerId,
        model,
        sessionID: session.getSessionFile(),
        tools,
        systemPrompt,
        temperature: 0.2,
        thinkingLevel,
        mode,
        budgetLedger: new BudgetLedger(),
        fileStateTracker,
        skills: skillRegistry.summaries(),
        memoryPrompt,
        externalHooks: hookController,
        // Cross-provider subagent routes (spawn_agent with "provider:model")
        // need a factory; without one the child blocks with
        // "no provider factory is configured". Default mirrors the TUI's
        // createProviderForRoute (OAuth prepare + configured+enabled+keyed
        // profile lookup); hosts may override per turn.
        providerFactory: options.providerFactory ?? this.defaultProviderFactory(),
        onMessageAppend: (message: Message) => {
          if (message.role === "system" || message.role === "meta") return;
          if (this.turnCoordinator.isDeleted(sessionId)) return;
          session.appendMessage(message);
          if (message.role === "assistant") recordMemoryCitations(cwd, message.content);
        },
        onCompactionApplied: (summary: string) => {
          if (this.turnCoordinator.isDeleted(sessionId)) return;
          session.applyLLMCompaction(summary);
        },
        onModeUpdate: (m: PermissionMode) => {
          if (!this.turnCoordinator.isDeleted(sessionId)) session.appendMarker("mode_switch", m);
        },
      });
      agentRef = agent;

      const history = session.getMessages();
      if (history.length > 0) {
        agent.messages = [{ role: "system", content: systemPrompt }, ...history];
      }

      reservation.markActive();
      options.onStart?.({
        providerId,
        model,
        thinkingLevel,
        mode,
        tools: tools.map((t) => t.name),
        skills: skillRegistry.summaries().map((s) => s.name),
      });

      // Match the TUI: a leading "/<skill-name> <task>" becomes an explicit
      // load-this-skill instruction, so invocation never depends on the model
      // recognizing the slash syntax on its own.
      const prompt = rewriteSkillInvocationPrompt(options.prompt, skillRegistry);

      const bareModelId = decodeModel(model).modelId;
      for await (const event of agent.run(prompt, cwd, {
        abortSignal,
        inputController,
      })) {
        const sdkEvent = this.handleSteerEvent(runtime, event, resolved);
        yield attachTurnCost(sdkEvent, providerId, bareModelId);
      }
      streamCompleted = true;
      for (const event of this.rejectOutstandingSteers(runtime, "no_continuation", resolved)) yield event;
    } catch (error) {
      const reason = abortSignal.aborted ? "turn_cancelled" : "turn_failed";
      for (const event of this.rejectOutstandingSteers(runtime, reason)) yield event;
      throw error;
    } finally {
      inputController.closePendingInputs();
      this.rejectOutstandingSteers(
        runtime,
        streamCompleted ? "no_continuation" : abortSignal.aborted ? "turn_cancelled" : "turn_failed",
        streamCompleted ? resolved : undefined,
      );
      unsubscribeQuestions();
      questionController.rejectAll();
      reservation.finish();
      if (this.turnRuntimes.get(reservation.id) === runtime) this.turnRuntimes.delete(reservation.id);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private runtimesForSession(sessionId: string): SdkTurnRuntime[] {
    return [...this.turnRuntimes.values()].filter((runtime) => runtime.sessionId === sessionId);
  }

  private settleSteerFromEvent(runtime: SdkTurnRuntime, event: AgentEvent): void {
    if (event.type !== "input_applied" && event.type !== "input_rejected") return;
    const pending = runtime.outcomes.get(event.id);
    if (!pending) return;
    runtime.outcomes.delete(event.id);
    pending.resolve(event);
  }

  private handleSteerEvent(
    runtime: SdkTurnRuntime,
    event: AgentEvent,
    resolved: { manager: SessionManager; cwd: string },
  ): AgentEvent {
    if (event.type === "input_rejected" && event.reason === "no_continuation") {
      const pending = runtime.outcomes.get(event.id);
      if (pending) return this.queuePendingSteer(runtime, pending, resolved, event);
    }
    this.settleSteerFromEvent(runtime, event);
    return event;
  }

  private rejectOutstandingSteers(
    runtime: SdkTurnRuntime,
    reason: "no_continuation" | "turn_failed" | "turn_cancelled",
    resolved?: { manager: SessionManager; cwd: string },
  ): AgentEvent[] {
    runtime.inputController.closePendingInputs();
    const events: AgentEvent[] = [];
    for (const [id, pending] of runtime.outcomes) {
      const event: Extract<AgentEvent, { type: "input_rejected" }> = {
        type: "input_rejected",
        id,
        content: pending.input.content,
        reason,
        target: "next_turn",
      };
      runtime.outcomes.delete(id);
      if (reason === "no_continuation" && resolved) {
        events.push(this.queuePendingSteer(runtime, pending, resolved, event));
      } else {
        pending.resolve(event);
        events.push(event);
      }
    }
    return events;
  }

  private queuePendingSteer(
    runtime: SdkTurnRuntime,
    pending: PendingSteerOutcome,
    resolved: { manager: SessionManager; cwd: string },
    rejected: Extract<AgentEvent, { type: "input_rejected" }>,
  ): Extract<AgentEvent, { type: "input_queued" | "input_rejected" }> {
    try {
      const queuedRuntime = this.startOwnedTurn(
        runtime.sessionId,
        { ...inheritableTurnOptions(runtime.options), prompt: pending.input.content },
        resolved,
        runtime.ownerKey,
      );
      const queued: Extract<AgentEvent, { type: "input_queued" }> = {
        type: "input_queued",
        id: pending.input.id,
        content: pending.input.content,
        turnId: queuedRuntime.reservation.id,
        target: "next_turn",
      };
      // The follow-up turn's own subscribers also see the queue marker; the
      // session-level log already gets it once via this turn's yielded event.
      queuedRuntime.events.append(queued);
      runtime.outcomes.delete(pending.input.id);
      pending.resolve(queued);
      return queued;
    } catch {
      runtime.outcomes.delete(pending.input.id);
      pending.resolve(rejected);
      return rejected;
    }
  }

  private queueDetachedInput(
    sessionId: string,
    content: string,
    resolved: { manager: SessionManager; cwd: string },
  ): SdkSteerResult {
    const ownerKey = resolved.manager.getSessionFile();
    try {
      claimProcessOwner(ownerKey, this);
      const input: AgentRunInput = {
        id: `sdk-steer-${++this.nextDetachedInputId}`,
        content,
        submittedAt: Date.now(),
      };
      const runtime = this.startOwnedTurn(
        sessionId,
        { ...(this.lastTurnOptions.get(sessionId) ?? {}), prompt: content },
        resolved,
        ownerKey,
      );
      const queued: Extract<AgentEvent, { type: "input_queued" }> = {
        type: "input_queued",
        id: input.id,
        content,
        turnId: runtime.reservation.id,
        target: "next_turn",
      };
      runtime.events.append(queued);
      this.publishSessionEvent(runtime, queued);
      return {
        accepted: true,
        disposition: "queued",
        input,
        turnId: runtime.reservation.id,
        outcome: Promise.resolve(queued),
      };
    } catch {
      releaseProcessOwner(ownerKey, this);
      return { accepted: false, disposition: "rejected", reason: "ownership_conflict" };
    }
  }

  private publishSessionEvent(
    runtime: SdkTurnRuntime,
    event: AgentEvent,
    terminal?: SdkSessionTerminal,
  ): void {
    const log = sessionEventLogFor(runtime.ownerKey);
    log.append({
      sequence: log.length + 1,
      sessionId: runtime.sessionId,
      turnId: runtime.reservation.id,
      event,
      ...(terminal ? { terminal } : {}),
    });
  }

  private ownerForSession(sessionId: string): BubbleSdk | undefined {
    const resolved = this.resolveSession(sessionId);
    return resolved ? processSessionOwners.get(resolved.manager.getSessionFile()) : undefined;
  }

  private bashAllowlistFor(sessionId: string): BashAllowlist {
    let allowlist = this.bashAllowlists.get(sessionId);
    if (!allowlist) {
      allowlist = new BashAllowlist();
      this.bashAllowlists.set(sessionId, allowlist);
    }
    return allowlist;
  }

  /**
   * Default cross-provider subagent factory over this SDK instance's own
   * registry — the same semantics as the TUI's createProviderForRoute. The
   * registry is reloaded first so a key added after construction works.
   */
  private defaultProviderFactory(): (route: ResolvedSubagentRoute) => Promise<Provider> {
    return async (route) => {
      const providerId = route.providerId;
      if (!providerId) {
        throw new Error(`Subagent route for model "${route.model}" did not include a provider.`);
      }
      // getConfigured() reads config.json from disk every call, so keys
      // added after SDK construction are picked up without a reload call.
      if (this.registry.supportsOAuth(providerId) && this.registry.getAuthStorage().has(providerId)) {
        await this.registry.prepareProvider(providerId);
      }
      const target = this.registry.getConfigured().find((item) => item.id === providerId);
      if (!target?.enabled || !target.apiKey) {
        throw new Error(
          `Subagent route requires provider "${providerId}", but it is not configured or has no active credentials.`,
        );
      }
      return createProviderInstance({
        providerId,
        apiKey: target.apiKey,
        baseURL: target.baseURL,
        protocol: target.protocol,
        headers: target.headers,
        openAICodexAuth: this.registry.createOpenAICodexAuthAdapter(providerId),
        grokAuth: this.registry.createGrokAuthAdapter(providerId),
      });
    };
  }

  /** MCP servers are started lazily, once per cwd (McpManager has no stop). */
  private mcpToolsFor(cwd: string): Promise<ToolRegistryEntry[]> {
    if (!this.mcpEnabled) return Promise.resolve([]);
    let cached = this.mcpToolsByCwd.get(cwd);
    if (!cached) {
      cached = (async () => {
        const loaded = loadMcpConfig({ cwd });
        if (loaded.servers.length === 0) return [];
        const manager = new McpManager({ servers: loaded.servers });
        await manager.start();
        return manager.getToolEntries();
      })().catch(() => []);
      this.mcpToolsByCwd.set(cwd, cached);
    }
    return cached;
  }

  private resolveSession(sessionId: string): { manager: SessionManager; cwd: string } | undefined {
    if (this.turnCoordinator.isDeleted(sessionId)) return undefined;
    const memCwd = this.cwdBySession.get(sessionId);
    if (memCwd) {
      // create() only resolves the path and loads iff the file exists, so this
      // covers both fresh (lazily persisted, not yet on disk) and resumed sessions.
      return { manager: SessionManager.create(memCwd, sessionFileName(sessionId)), cwd: memCwd };
    }
    if (this.sessionIndex.size === 0) this.listSessions();
    const entry = this.sessionIndex.get(sessionId);
    if (!entry) {
      // A session created in this process but not yet persisted to disk is
      // still routable for other SDK instances (ownership conflict window).
      const location = processSessionLocations.get(sessionId);
      if (!location) return undefined;
      this.cwdBySession.set(sessionId, location.cwd);
      return {
        manager: SessionManager.create(location.cwd, sessionFileName(sessionId)),
        cwd: location.cwd,
      };
    }
    this.cwdBySession.set(sessionId, entry.cwd);
    return { manager: new SessionManager(entry.file), cwd: entry.cwd };
  }

  private resolveProvider(
    promptCacheKey: string,
    explicitModel?: string,
  ): { provider: Provider; providerId: string; model: string } {
    const configuredModel = explicitModel || this.userConfig.getDefaultModel();
    const defaultProvider = this.registry.getDefault();
    const fallbackProviderId = defaultProvider?.id ?? "";
    const normalized = configuredModel
      ? configuredModel.includes(":")
        ? configuredModel
        : fallbackProviderId
          ? encodeModel(fallbackProviderId, configuredModel)
          : ""
      : "";
    const { providerId: effId, modelId: effModelId } = normalized
      ? decodeModel(normalized)
      : { providerId: undefined, modelId: "" };
    const activeProviderId = effId || fallbackProviderId;
    if (effModelId) assertProviderModelAllowed(activeProviderId, effModelId);
    const target =
      this.registry.getConfigured().find((p) => p.id === activeProviderId) || defaultProvider;
    if (!target?.apiKey) {
      throw new Error("No provider with an API key configured — run the Bubble CLI once to set one up");
    }
    const activeModel = effModelId ? encodeModel(activeProviderId, effModelId) : "";
    const provider = createProviderInstance({
      providerId: activeProviderId,
      apiKey: target.apiKey,
      baseURL: target.baseURL,
      promptCacheKey,
      protocol: target.protocol,
      headers: target.headers,
    });
    return { provider, providerId: activeProviderId, model: activeModel };
  }
}

/**
 * Process-local ownership routes every producer to one SDK runner. Hosts that
 * run multiple OS processes still need a broker or distributed per-session
 * lease; two processes cannot safely share a local JSONL transcript directly.
 */
const processSessionOwners = new Map<string, BubbleSdk>();
const sessionEventLogs = new Map<string, ReplayEventLog<SdkSessionEvent>>();
/** sessionId -> {ownerKey, cwd} for sessions created here but not yet on disk. */
const processSessionLocations = new Map<string, { ownerKey: string; cwd: string }>();

function claimProcessOwner(ownerKey: string, sdk: BubbleSdk): void {
  const existing = processSessionOwners.get(ownerKey);
  if (existing && existing !== sdk) {
    throw new Error(`SDK session is owned by another runner: ${ownerKey}`);
  }
  processSessionOwners.set(ownerKey, sdk);
}

function releaseProcessOwner(ownerKey: string, sdk: BubbleSdk): void {
  if (processSessionOwners.get(ownerKey) === sdk) processSessionOwners.delete(ownerKey);
}

function sessionEventLogFor(ownerKey: string): ReplayEventLog<SdkSessionEvent> {
  let log = sessionEventLogs.get(ownerKey);
  if (!log) {
    log = new ReplayEventLog<SdkSessionEvent>();
    sessionEventLogs.set(ownerKey, log);
  }
  return log;
}

/** End live iterators and drop the buffered events of a deleted session. */
function releaseSessionEventLog(ownerKey: string): void {
  const log = sessionEventLogs.get(ownerKey);
  if (!log) return;
  log.close();
  sessionEventLogs.delete(ownerKey);
}

function inheritableTurnOptions(
  options: RunTurnOptions,
): Omit<RunTurnOptions, "prompt" | "signal"> {
  const { prompt: _prompt, signal: _signal, ...inherited } = options;
  return inherited;
}

function sessionFileName(sessionId: string): string {
  return sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`;
}

function pendingSteerOutcome(input: AgentRunInput): PendingSteerOutcome {
  let resolve!: (outcome: SdkSteerOutcome) => void;
  const promise = new Promise<SdkSteerOutcome>((done) => {
    resolve = done;
  });
  return { input, promise, resolve };
}

function throwAbortSignal(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new AgentAbortError(typeof signal.reason === "string" ? signal.reason : "SDK turn cancelled.");
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    try {
      throwAbortSignal(signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      try {
        throwAbortSignal(signal);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Attach a `cost` field to turn_end events that carry usage, priced via the
 * static pricing table. Pricing is an accounting concern, so it rides along
 * here in the SDK rather than in the agent core. Multi-step turns emit several
 * turn_end events; each cost covers only that step's usage, so hosts sum them.
 * Events for unpriced models (or without usage) pass through untouched.
 */
export function attachTurnCost(
  event: AgentEvent,
  providerId: string,
  modelId: string,
  at: Date = new Date(),
): AgentEvent {
  if (event.type !== "turn_end" || !event.usage) return event;
  const cost = calculateUsageCost(providerId, modelId, event.usage, at);
  return cost ? { ...event, cost } : event;
}

/**
 * If the prompt (or its first text part) is a "/<skill-name> <task>" skill
 * invocation, rewrite it into the same explicit execution prompt the TUI
 * sends. Non-matching prompts pass through untouched.
 */
export function rewriteSkillInvocationPrompt(
  prompt: string | ContentPart[],
  registry: SkillRegistry,
): string | ContentPart[] {
  if (typeof prompt === "string") {
    return parseSkillInvocation(prompt, registry)?.actualPrompt ?? prompt;
  }
  const index = prompt.findIndex((part) => part.type === "text");
  if (index === -1) return prompt;
  const part = prompt[index] as Extract<ContentPart, { type: "text" }>;
  const rewritten = parseSkillInvocation(part.text, registry)?.actualPrompt;
  if (!rewritten) return prompt;
  const next = prompt.slice();
  next[index] = { ...part, text: rewritten };
  return next;
}

// ── Building blocks (escape hatch for custom hosts) ────────────────────────

export { Agent, AgentAbortError, type AgentOptions, type AgentRunOptions } from "../agent.js";
export { AgentRunInputQueue } from "../agent/input-controller.js";
export {
  SessionManager,
  getSessionsDir,
  type SessionSummary,
  type UserTurn,
  type RewindResult,
} from "../session.js";
export { PermissionAwareApprovalController } from "../approval/controller.js";
export { BashAllowlist } from "../approval/session-cache.js";
export type { ApprovalController, ApprovalDecision, ApprovalRequest } from "../approval/types.js";
export { createAllTools, buildToolPromptOptions, type PlanController } from "../tools/index.js";
export { buildSystemPrompt } from "../system-prompt.js";
export { FileStateTracker } from "../tools/file-state.js";
export { BudgetLedger } from "../agent/budget-ledger.js";
export { UserConfig } from "../config.js";
export {
  ProviderRegistry,
  encodeModel,
  decodeModel,
  displayModel,
  type ProviderProfile,
  type ModelInfo,
} from "../provider-registry.js";
export { createProviderInstance } from "../provider.js";
export { getDefaultThinkingLevel } from "../variant/variant-resolver.js";
export {
  QuestionController,
  QuestionRejectedError,
  type QuestionAnswer,
  type QuestionEvent,
  type QuestionRequest,
} from "../question/controller.js";
export { SkillRegistry } from "../skills/registry.js";
export { parseSkillInvocation, type SkillInvocation } from "../skills/invocation.js";
export type { SkillSummary } from "../skills/types.js";
export { GoalStore } from "../goal/store.js";
export { McpManager } from "../mcp/manager.js";
export { loadMcpConfig } from "../mcp/config.js";
export { ExternalHookController } from "../hooks/controller.js";
export {
  calculateUsageCost,
  getModelPricing,
  type ModelPricing,
  type PricingCurrency,
} from "../model-pricing.js";
export { registry as slashCommandRegistry } from "../slash-commands/index.js";
export type { SlashCommandContext } from "../slash-commands/types.js";
export type {
  AgentEvent,
  AgentInputController,
  AgentRunInput,
  ContentPart,
  Message,
  PermissionMode,
  Provider,
  ThinkingLevel,
  TokenUsage,
  UsageCost,
  ToolRegistryEntry,
  ToolResult,
  ToolUpdate,
} from "../types.js";

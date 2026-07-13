/**
 * Agent - The core decision loop.
 * It maintains message state, calls the LLM, executes tools, and auto-continues.
 */

import { compactMessages } from "./context/compact.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBubbleHome } from "./bubble-home.js";
import { compactMessagesWithLLM } from "./context/compact-llm.js";
import { estimateContextTokens, getContextBudget } from "./context/budget.js";
import { buildContextUsageSnapshot, type ContextUsageSnapshot } from "./context/usage.js";
import { isContextOverflowError } from "./context/overflow.js";
import {
  computeRetryDelayMs,
  isProviderStreamInterruption,
  MAX_STREAM_INTERRUPTION_RETRIES,
  sleepBeforeRetry,
} from "./network/retry.js";
import { projectMessages } from "./context/projector.js";
import { aggressivePruneMessages, markStableCurrentToolResultsForCache } from "./context/prune.js";
import { truncateToolOutputForModel } from "./context/tool-output-truncate.js";
import { buildDeferredToolsReminder, buildToolFreezeReminder, reminderForMode } from "./prompt/reminders.js";
import type { AgentEvent, AgentInputController, AgentRunInput, ContentPart, PermissionMode, Message, ParsedToolCall, Provider, ProviderMessage, ProviderMetadataProvider, ProviderRawContentBlock, ThinkingLevel, Todo, TokenUsage, ToolDefinition, ToolResult, ToolRegistryEntry, ToolUpdate } from "./types.js";
import { HookBus, type TurnHooks, type TurnHookState } from "./orchestrator/hooks.js";
import type { ExternalHookController } from "./hooks/controller.js";
import {
  normalizeHookInput,
  truncateHookText,
  type HookCombinedResult,
  type HookProgressEvent,
  type HookRunRequest,
} from "./hooks/index.js";
import { createDefaultHooks } from "./orchestrator/default-hooks.js";
import { mergeAgentCategories, parseThinkingLevel, resolveModelRoute, resolveSubagentRoute, type AgentCategoriesConfig, type ResolvedSubagentRoute } from "./agent/categories.js";
import { DEFAULT_AGENT_ROUTING, nearModelMatches, sanitizeAgentRouting, tierContextFromSnapshot, type AgentRoutingConfig, type RoutableModelEntry, type RoutableModelIndex, type RoutingSnapshot, type RoutingSnapshotAccessor } from "./agent/routing-catalog.js";
import { buildModelRoutingPrompt } from "./prompt/routing.js";
import { getBuiltinModel } from "./model-catalog.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeInheritedThinkingLevel, normalizeThinkingLevel } from "./variant/variant-resolver.js";
import { appendOutputSchemaInstructions, buildSchemaCorrectionPrompt, validateStructuredSummary } from "./agent/structured-output.js";
import { runWorkflow, WorkflowConcurrencyGate, type AgentDispatchResult, type WorkflowAgentSpec } from "./agent/workflow/runtime.js";
import { buildWorkflowDeliveryNotice, renderWorkflowResultValue, type WorkflowRunRecord, type WorkflowRunSnapshot } from "./agent/workflow/control.js";
import { BudgetLedger, composeAbortSignals } from "./agent/budget-ledger.js";
import { assignAgentNickname, builtinAgentProfiles, discoverAgentProfiles, findAgentProfile, mergeUsage, selectToolsForAgentProfile, validateAgentProfileTools, type AgentProfile, type SubagentRunResult } from "./agent/profiles.js";
import { snapshotSubagentThread, subagentResultFromThread, type PendingSubagentToolUpdate, type SubagentFinalReason, type SubagentThreadRecord, type SubagentThreadSnapshot } from "./agent/subagent-control.js";
import { SubagentStore } from "./agent/subagent-store.js";
import { SubagentScheduler, type SubagentRunOutcome } from "./agent/subagent-scheduler.js";
import { ChildRunner, classifySubagentAbortReason, type ChildRunOptions } from "./agent/child-runner.js";
import { ResultIntegrator } from "./agent/result-integrator.js";
import { AgentAbortError, EMPTY_ASSISTANT_FALLBACK, SubagentAbortError } from "./agent/abort-errors.js";
import { createSubagentWorktree, finalizeSubagentWorktree } from "./agent/worktree.js";
import { createWorktreeChildTools, isolateReadonlyChildFileTools } from "./tools/child-tools.js";
import { type RateLimitPolicy } from "./network/errors.js";
import { isHiddenToolResult } from "./agent/discovery-barrier.js";
import {
  createStreamingInternalReminderSanitizer,
  sanitizeAssistantProviderMetadata,
  sanitizeInternalReasoningText,
  sanitizeInternalReminderBlocks,
} from "./agent/internal-reminder-sanitizer.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { isOnlyProviderProtocolArtifacts, stripProviderProtocolArtifacts } from "./provider-artifacts.js";
import { debugReasoningStream, summarizeDebugText } from "./reasoning-debug.js";
import type { SkillSummary } from "./skills/types.js";
import type { FileStateTracker } from "./tools/file-state.js";
import { buildToolPromptOptions } from "./tools/prompt-metadata.js";
import { stopAutoServersForSession } from "./tools/server-manager.js";
import {
  summarizeAgentEventForTrace,
  summarizeTraceError,
  summarizeTraceMessage,
  summarizeTraceToolResult,
  summarizeTraceValue,
  traceEvent,
} from "./debug-trace.js";

const MAX_CONSECUTIVE_OVERFLOW_RECOVERIES = 3;
const RESIDENT_HISTORY_KEEP_RECENT_TURNS = 3;
const RESIDENT_HISTORY_MESSAGE_LIMIT = 160;
const RESIDENT_HISTORY_CHAR_SOFT_LIMIT = 256 * 1024;
const RESIDENT_HISTORY_CHAR_HARD_LIMIT = 512 * 1024;
const RESIDENT_HISTORY_HEAP_HARD_LIMIT = 768 * 1024 * 1024;
const MAX_EMPTY_ASSISTANT_RECOVERIES = 1;
const EMPTY_ASSISTANT_RECOVERY_REMINDER =
  "The previous model response contained no user-visible assistant content and no tool calls. " +
  "Respond now with a concise, user-visible answer, or call an available tool if more work is required. " +
  "Do not put the final answer only in hidden reasoning.";
export { AgentAbortError, SubagentAbortError } from "./agent/abort-errors.js";
// Model-facing interruption boundary. Persisted into the transcript so the
// next turn sees an explicit stop instead of a dangling request — but it must
// never render in the UI as if the assistant said it (the TUIs strip it and
// show their own interrupt indicator instead).
export const INTERRUPTED_ASSISTANT_CONTENT =
  "Interrupted by user. The prior request was stopped and should not be resumed unless the user asks.";

function agentEventFromHookProgress(event: HookProgressEvent): AgentEvent {
  const source = `${event.source.scope}:${event.source.index}`;
  if (event.type === "hook_start") {
    return {
      type: "hook_start",
      eventName: event.eventName,
      hookId: event.hookId,
      source,
    };
  }
  if (event.type === "hook_end") {
    return {
      type: "hook_end",
      eventName: event.eventName,
      hookId: event.hookId,
      source,
      elapsedMs: event.elapsedMs ?? 0,
      decision: event.decision ?? "allow",
      reason: event.reason,
    };
  }
  return {
    type: "hook_error",
    eventName: event.eventName,
    hookId: event.hookId,
    source,
    elapsedMs: event.elapsedMs,
    decision: event.decision,
    reason: event.reason,
    error: event.error ?? "Hook failed.",
  };
}

/** Runtime tuning for the subagent scheduler. */
export interface AgentSubagentRuntimeConfig {
  maxActiveSubagents?: number;
  launchBurst?: number;
  launchIntervalMs?: number;
  rateLimitMaxAttempts?: number;
  rateLimitBackoffMs?: number[];
  transportRetryMaxAttempts?: number;
  transportRetryBackoffMs?: number[];
  /**
   * Directory for persisted child state (design §7). Defaults to
   * `<session>.subagents` next to the session file when a session exists.
   */
  persistDir?: string;
}

export interface AgentOptions {
  provider: Provider;
  sessionID?: string;
  providerId?: string;
  model: string;
  tools: ToolRegistryEntry[];
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
  mode?: PermissionMode;
  steps?: number;
  maxTurns?: number;
  taskBudget?: { total: number };
  todos?: Todo[];
  systemPrompt?: string;
  onMessageAppend?: (message: Message) => void;
  onToolResult?: (toolName: string, result: ToolResult) => void;
  onTodosUpdate?: (todos: Todo[]) => void;
  onModeUpdate?: (mode: PermissionMode) => void;
  hooks?: TurnHooks[];
  externalHooks?: ExternalHookController;
  agentRole?: "parent" | "subagent";
  subAgentId?: string;
  budgetLedger?: BudgetLedger;
  budgetSource?: { runId: string; subAgentId?: string };
  skills?: SkillSummary[];
  memoryPrompt?: string;
  fileStateTracker?: FileStateTracker;
  agentCategories?: AgentCategoriesConfig;
  /**
   * Routing config held directly on the Agent, independent of any snapshot:
   * the cross-provider lock must hold even in hosts that wire no routing
   * data (design §7.0).
   */
  agentRouting?: Partial<AgentRoutingConfig>;
  /**
   * Live routing-snapshot accessor (design §1.5). Host-constructed; caches by
   * registry revision. When absent, catalog-dependent features (tier routing,
   * menu, unknown-model validation) are simply off.
   */
  routingSnapshot?: RoutingSnapshotAccessor;
  /**
   * Cross-provider routable model index (design v3.6): powers the user-named
   * model reminder and near-match correction of mistyped provider:model ids.
   */
  routableModels?: RoutableModelIndex;
  providerFactory?: (route: ResolvedSubagentRoute) => Provider | Promise<Provider>;
  subagents?: AgentSubagentRuntimeConfig;
  /** Subagent routes use "defer" so the scheduler is the single 429 backoff layer (design §4.5). */
  rateLimitPolicy?: RateLimitPolicy;
}

export interface AgentRunOptions {
  abortSignal?: AbortSignal;
  inputController?: AgentInputController;
  /**
   * Internal: re-enter the loop without appending the input as a new user
   * message. Used by the subagent scheduler's rate-limit re-entry so a child
   * history contains exactly one copy of its input (design doc §4.5).
   */
  resumeWithoutInput?: boolean;
}

/** Detector threshold N (design §6): 1–2 strong-model children are often a
 * deliberate deep side-investigation; at 3+ uniform defaults the odds that
 * all need frontier capability drop sharply. Revisit against live traces. */
const ROUTING_REMINDER_THRESHOLD = 3;

export class Agent {
  messages: Message[] = [];
  private provider: Provider;
  private sessionID?: string;
  private _providerId: string;
  private _model: string;
  private tools: Map<string, ToolRegistryEntry> = new Map();
  private unlockedDeferred: Set<string> = new Set();
  private temperature: number;
  private thinkingLevel: ThinkingLevel;
  private _mode: PermissionMode;
  private _modeVersion = 0;
  private onModeUpdate?: (mode: PermissionMode) => void;
  private _todos: Todo[];
  private _todosVersion = 0;
  private onTodosUpdate?: (todos: Todo[]) => void;
  private onMessageAppend?: (message: Message) => void;
  private onToolResult?: (toolName: string, result: ToolResult) => void;
  private hookDefinitions: TurnHooks[];
  private externalHooks?: ExternalHookController;
  private agentRole: "parent" | "subagent";
  private subAgentId?: string;
  private maxTurns?: number;
  private taskBudget?: { total: number };
  private budgetLedger?: BudgetLedger;
  private budgetSource: { runId: string; subAgentId?: string };
  private skillSummaries: SkillSummary[];
  private memoryPrompt?: string;
  private fileStateTracker?: FileStateTracker;
  private agentCategories: AgentCategoriesConfig;
  private agentRouting: AgentRoutingConfig;
  private routingSnapshotAccessor?: RoutingSnapshotAccessor;
  private routableModelIndex?: RoutableModelIndex;
  /** Detector state (design §6): once per session, absolute defaulted count. */
  private routingReminderFired = false;
  private defaultedRoutingStreak = 0;
  private pendingRoutingReminder?: string;
  private providerFactory?: (route: ResolvedSubagentRoute) => Provider | Promise<Provider>;
  private readonly subagentStore: SubagentStore;
  private readonly subagentScheduler: SubagentScheduler;
  private readonly childRunner: ChildRunner;
  private readonly resultIntegrator = new ResultIntegrator();
  /** Background dynamic-workflow runs (option C Phase 4), keyed by runId. */
  private readonly workflowRuns = new Map<string, WorkflowRunRecord>();
  /** runIds whose completed result should be ingested at the next turn. */
  private readonly pendingWorkflowDeliveries = new Set<string>();
  private subagentsConfig: AgentSubagentRuntimeConfig;
  private readonly rateLimitPolicy?: RateLimitPolicy;
  private pendingSubagentUpdates: PendingSubagentToolUpdate[] = [];
  /**
   * Wakers for tool-execution update loops currently awaiting updates. A
   * blocking lifecycle tool (wait_workflow / wait_agent) produces no updates of
   * its own, so without this wake the background children's queued lifecycle
   * updates sit undrained until the tool settles — the UI would only show
   * subagent traces after the whole team finished.
   */
  private readonly subagentUpdateWakers = new Set<() => void>();
  private lastInputTokens: number | null = null;
  private lastAnchorMessageCount: number | null = null;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.sessionID = options.sessionID;
    this._providerId = options.providerId ?? "";
    this._model = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.thinkingLevel = options.thinkingLevel ?? "off";
    this._mode = options.mode ?? "default";
    this._todos = options.todos ? [...options.todos] : [];
    this.onMessageAppend = options.onMessageAppend;
    this.onToolResult = options.onToolResult;
    this.onTodosUpdate = options.onTodosUpdate;
    this.onModeUpdate = options.onModeUpdate;
    this.hookDefinitions = options.hooks ?? [];
    this.externalHooks = options.externalHooks;
    this.agentRole = options.agentRole ?? "parent";
    this.subAgentId = options.subAgentId;
    this.maxTurns = options.maxTurns ?? options.steps;
    this.taskBudget = options.taskBudget;
    this.budgetLedger = options.budgetLedger;
    this.budgetSource = options.budgetSource ?? { runId: this.sessionID ?? "agent" };
    this.skillSummaries = options.skills ?? [];
    this.memoryPrompt = options.memoryPrompt;
    this.fileStateTracker = options.fileStateTracker;
    this.agentCategories = options.agentCategories ?? {};
    this.agentRouting = options.agentRouting
      ? sanitizeAgentRouting(options.agentRouting)
      : { ...DEFAULT_AGENT_ROUTING };
    this.routingSnapshotAccessor = options.routingSnapshot;
    this.routableModelIndex = options.routableModels;
    this.providerFactory = options.providerFactory;
    this.subagentsConfig = options.subagents ?? {};
    this.rateLimitPolicy = options.rateLimitPolicy;
    // Children persist next to the session file so a later process can
    // resume them via send_input (design §7). Child agents themselves
    // (agentRole "subagent") never persist children — no recursion exists.
    const persistDir = this.agentRole === "parent"
      ? this.subagentsConfig.persistDir
        ?? (this.sessionID?.endsWith(".jsonl") ? this.sessionID.replace(/\.jsonl$/, ".subagents") : undefined)
      : undefined;
    this.subagentStore = new SubagentStore(persistDir);
    this.subagentStore.loadPersisted();
    this.subagentScheduler = new SubagentScheduler({
      maxActiveSubagents: this.subagentsConfig.maxActiveSubagents,
      launchBurst: this.subagentsConfig.launchBurst,
      launchIntervalMs: this.subagentsConfig.launchIntervalMs,
      rateLimitMaxAttempts: this.subagentsConfig.rateLimitMaxAttempts,
      rateLimitBackoffMs: this.subagentsConfig.rateLimitBackoffMs,
      transportRetryMaxAttempts: this.subagentsConfig.transportRetryMaxAttempts,
      transportRetryBackoffMs: this.subagentsConfig.transportRetryBackoffMs,
      getCategoryLimit: (category) => mergeAgentCategories(this.agentCategories)[category]?.maxConcurrent,
    });
    this.childRunner = new ChildRunner({
      allTools: () => [...this.tools.values()],
      emit: (record, options, status, event, message) => this.emitSubagentLifecycle(record, options, status, event, message),
      runLifecycleHook: (record, cwd, eventName, status, error, abortSignal) =>
        this.runSubagentLifecycleHookFor(record, cwd, eventName, status, error, abortSignal),
      finalizeBlocked: (record, error, options) => this.finalizeSubagentBlocked(record, error, options),
      createInstance: (record, tools, cwd, forkContext) => this.createSubAgentInstance(record, tools, cwd, forkContext),
      notifyWaiters: (record) => this.subagentStore.notifyWaiters(record),
      onFinal: (record, options) => {
        if (record.worktree) {
          // Inspect and clean up the worktree: unchanged → removed; changed →
          // kept for the parent to review, with a diff stat in the handoff (§8).
          finalizeSubagentWorktree(record.worktree);
          if (record.worktree.changed) {
            record.toolNotes.push(`worktree: changes left in ${record.worktree.path} — review the diff before applying`);
          }
        }
        // Workflow-internal agents are not persisted (they never re-import into
        // the store on restart) and never ingest into parent context (option C).
        if (!record.workflowInternal) {
          this.subagentStore.persist(record);
          this.maybeEnqueueIngestion(record, options);
        }
      },
    });

    if (options.systemPrompt) {
      this.messages.push({ role: "system", content: options.systemPrompt });
    }

    for (const tool of options.tools) {
      this.tools.set(tool.name, tool);
    }

    // If the agent boots in a non-default mode, inject the corresponding reminder so the
    // model sees the active rules on its very first turn. Default mode needs no reminder.
    if (this._mode !== "default") {
      this.injectModeReminder();
    }

    // Advertise any deferred tools so the model knows they exist and how to
    // reach them. Keeps the per-turn tool list small; schemas load on demand.
    this.injectDeferredToolsReminder();
  }

  /**
   * Re-inject the deferred-tools advertisement. Hosts that reassign
   * agent.messages (session resume, Feishu conversation rebuild) drop the
   * constructor-injected meta reminder — without re-injection the model has
   * no way to discover deferred tools, since they are also filtered out of
   * the prompt's tool list.
   */
  injectDeferredToolsReminder(): void {
    const deferredNames = [...this.tools.values()]
      .filter((t) => t.deferred)
      .map((t) => t.name);
    if (deferredNames.length > 0) {
      this.injectSystemReminder(buildDeferredToolsReminder(deferredNames));
    }
  }

  private async runExternalHook(
    request: HookRunRequest,
    abortSignal?: AbortSignal,
  ): Promise<{ result: HookCombinedResult; events: AgentEvent[] }> {
    const events: AgentEvent[] = [];
    if (!this.externalHooks) {
      return {
        result: {
          eventName: request.eventName,
          decision: "allow",
          modelContext: [],
          results: [],
          diagnostics: [],
          matched: 0,
        },
        events,
      };
    }
    const result = await this.externalHooks.runEvent({
      agentRole: this.agentRole,
      subAgentId: this.subAgentId,
      sessionId: this.sessionID,
      ...request,
    }, {
      abortSignal,
      onProgress: (event) => events.push(agentEventFromHookProgress(event)),
    });
    return { result, events };
  }

  private injectHookModelContext(result: HookCombinedResult): void {
    for (const context of result.modelContext) {
      this.injectSystemReminder(`[Hook ${result.eventName}] ${context}`);
    }
  }

  /** Whether a tool is registered on this agent (e.g. delegation tools on parents). */
  hasToolAvailable(name: string): boolean {
    return this.tools.has(name);
  }

  /** Unlock a list of deferred tools so they're included in subsequent turns. */
  unlockDeferredTools(names: string[]): void {
    for (const n of names) {
      if (this.tools.has(n)) this.unlockedDeferred.add(n);
    }
  }

  /** All deferred tools in this session (for tool_search to inspect). */
  listDeferredTools(): ToolRegistryEntry[] {
    return [...this.tools.values()].filter((t) => t.deferred);
  }

  getSystemPromptToolOptions(): Pick<import("./system-prompt.js").SystemPromptOptions, "tools" | "toolSnippets" | "guidelines" | "modelRoutingPrompt"> {
    return {
      ...buildToolPromptOptions(this.getActiveToolEntries()),
      // Rendered through the live accessor (design §1.5), so every host-
      // triggered prompt rebuild picks up the current catalog.
      modelRoutingPrompt: this.buildModelRoutingPromptSection(),
    };
  }

  /** Current routing menu (design §4); undefined when no accessor is wired. */
  buildModelRoutingPromptSection(): string | undefined {
    const snapshot = this.currentRoutingSnapshot();
    if (!snapshot) return undefined;
    return buildModelRoutingPrompt(snapshot, this.agentRouting);
  }

  /**
   * Routing menu rendered for a prospective parent route — used by model-
   * switch transactions to build the NEXT prompt before mutating the agent
   * (design §1.5).
   */
  renderModelRoutingPromptFor(parent: { providerId: string; model: string }): string | undefined {
    if (!this.routingSnapshotAccessor) return undefined;
    try {
      return buildModelRoutingPrompt(this.routingSnapshotAccessor(parent), this.agentRouting);
    } catch {
      return undefined;
    }
  }

  getContextUsageSnapshot(): ContextUsageSnapshot {
    return buildContextUsageSnapshot({
      providerId: this.providerId,
      modelId: this.apiModel,
      messages: this.messages,
      toolEntries: this.getActiveToolEntries(),
      deferredToolEntries: this.listDeferredTools(),
      skills: this.skillSummaries,
    });
  }

  resetContextUsageAnchor(): void {
    this.lastInputTokens = null;
    this.lastAnchorMessageCount = null;
    this.fileStateTracker?.invalidateReadHistory();
  }

  /** Whether a given tool is deferred and not yet unlocked. */
  isDeferredAndLocked(name: string): boolean {
    const tool = this.tools.get(name);
    return !!tool?.deferred && !this.unlockedDeferred.has(name);
  }

  private getActiveToolEntries(): ToolRegistryEntry[] {
    return [...this.tools.values()]
      .filter((tool) => !tool.deferred || this.unlockedDeferred.has(tool.name));
  }

  injectSystemReminder(content: string): void {
    this.appendMessage({ role: "meta", kind: "system-reminder", content });
  }

  injectModeReminder(): void {
    const reminder = reminderForMode(this._mode);
    const last = this.messages.at(-1);
    if (
      last?.role === "meta"
      && last.kind === "system-reminder"
      && last.content === reminder
    ) {
      return;
    }
    this.injectSystemReminder(reminder);
  }

  get model(): string {
    return this._model;
  }

  set model(value: string) {
    this._model = value;
  }

  get providerId(): string {
    return this._providerId;
  }

  set providerId(value: string) {
    this._providerId = value;
  }

  get apiModel(): string {
    if (this._model.includes(":")) {
      return this._model.split(":").slice(1).join(":");
    }
    return this._model;
  }

  setProvider(provider: Provider) {
    this.provider = provider;
  }

  complete(
    messages: Message[],
    options?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal },
  ): Promise<string> {
    return this.provider.complete(projectMessages(messages), {
      model: options?.model ?? this.apiModel,
      temperature: options?.temperature ?? this.temperature,
      thinkingLevel: options?.thinkingLevel ?? this.thinkingLevel,
      abortSignal: options?.abortSignal,
    });
  }

  get thinking(): ThinkingLevel {
    return this.thinkingLevel;
  }

  set thinking(value: ThinkingLevel) {
    this.thinkingLevel = value;
  }

  get reasoning(): ThinkingLevel {
    return this.thinkingLevel;
  }

  set reasoning(value: ThinkingLevel) {
    this.thinkingLevel = value;
  }

  get mode(): PermissionMode {
    return this._mode;
  }

  set mode(value: PermissionMode) {
    this.setMode(value);
  }

  setMode(value: PermissionMode): void {
    if (this._mode === value) return;
    this._mode = value;
    this._modeVersion += 1;
    this.injectModeReminder();
    this.onModeUpdate?.(value);
  }

  /** Internal: snapshot counter that bumps on every mode change. Used by run loop. */
  get modeVersion(): number {
    return this._modeVersion;
  }

  getTodos(): Todo[] {
    return this._todos.map((todo) => ({ ...todo }));
  }

  setTodos(next: Todo[]): void {
    this._todos = next.map((todo) => ({ ...todo }));
    this._todosVersion += 1;
    this.onTodosUpdate?.(this.getTodos());
  }

  /** Internal: snapshot counter that bumps on every setTodos. Used by run loop to detect mutations. */
  get todosVersion(): number {
    return this._todosVersion;
  }

  setSystemPrompt(prompt: string) {
    const systemMessage: Extract<Message, { role: "system" }> = { role: "system", content: prompt };
    if (this.messages[0]?.role === "system") {
      this.messages[0] = systemMessage;
      return;
    }
    this.messages.unshift(systemMessage);
  }

  async *run(
    userInput: string | ContentPart[],
    cwd: string,
    options: AgentRunOptions = {},
  ): AsyncIterable<AgentEvent> {
    const abortSignal = options.abortSignal;
    const inputController = options.inputController;
    const traceContext = {
      cwd,
      sessionFile: this.sessionID,
      provider: this._providerId || "none",
      model: this.apiModel || "none",
    };
    const runId = randomUUID();
    const emit = (event: AgentEvent): AgentEvent => {
      traceEvent("agent_event", summarizeAgentEventForTrace(event), traceContext);
      return event;
    };
    traceEvent("agent_run_start", {
      input: summarizeTraceValue(userInput),
      mode: this._mode,
      messageCount: this.messages.length,
      toolCount: this.tools.size,
      deferredUnlocked: this.unlockedDeferred.size,
    }, traceContext);
    throwIfAborted(abortSignal);
    const hookBus = new HookBus();
    for (const hooks of createDefaultHooks()) {
      hookBus.register(hooks);
    }
    for (const hooks of this.hookDefinitions) {
      hookBus.register(hooks);
    }
    const hookState: TurnHookState = {};
    const reminderQueue: string[] = [];
    const queueReminder = (reminder: string) => {
      reminderQueue.push(reminder);
    };
    const pendingInputCount = () => inputController?.pendingInputCount() ?? 0;
    const applyPendingInputs = async (): Promise<AgentEvent[]> => {
      const pendingInputs = inputController?.drainPendingInputs() ?? [];
      if (pendingInputs.length === 0) return [];
      const events: AgentEvent[] = [];
      for (const input of pendingInputs) {
        const hook = await this.runExternalHook({
          eventName: "SteerInputApplied",
          cwd,
          runId,
          target: "current_turn",
          payload: {
            id: input.id,
            target: "current_turn",
            ...normalizeHookInput(input.content),
          },
          fullPayload: { prompt: input.content },
        }, abortSignal);
        events.push(...hook.events);
        this.injectHookModelContext(hook.result);
        this.appendMessage({ role: "user", content: input.content });
        events.push({
          type: "input_applied",
          id: input.id,
          content: input.content,
          target: "current_turn",
        });
      }
      events.push({ type: "input_pending_changed", pending: pendingInputCount() });
      return events;
    };
    const rejectPendingInputs = async (reason: "no_continuation"): Promise<AgentEvent[]> => {
      const pendingInputs: AgentRunInput[] = inputController?.drainPendingInputs() ?? [];
      if (pendingInputs.length === 0) return [];
      const events: AgentEvent[] = [];
      for (const input of pendingInputs) {
        const hook = await this.runExternalHook({
          eventName: "QueuedInputRejected",
          cwd,
          runId,
          target: "next_turn",
          payload: {
            id: input.id,
            reason,
            target: "next_turn",
            ...normalizeHookInput(input.content),
          },
          fullPayload: { prompt: input.content },
        }, abortSignal);
        events.push(...hook.events);
        this.injectHookModelContext(hook.result);
        events.push({
          type: "input_rejected",
          id: input.id,
          content: input.content,
          reason,
          target: "next_turn",
        });
      }
      events.push({ type: "input_pending_changed", pending: pendingInputCount() });
      return events;
    };
    const flushGovernorReminders = () => {
      for (const reminder of reminderQueue.splice(0, reminderQueue.length)) {
        this.injectSystemReminder(reminder);
      }
    };

    if (this._todos.length > 0 && this._todos.every((t) => t.status === "completed")) {
      this.setTodos([]);
      yield emit({ type: "todos_updated", todos: [] });
    }
    if (!options.resumeWithoutInput) {
      const promptHook = await this.runExternalHook({
        eventName: "UserPromptSubmit",
        cwd,
        runId,
        target: typeof userInput === "string" ? userInput : "content_parts",
        payload: normalizeHookInput(userInput),
        fullPayload: { prompt: userInput },
      }, abortSignal);
      for (const event of promptHook.events) yield emit(event);
      if (promptHook.result.decision === "deny") {
        const message = promptHook.result.reason
          ?? `Prompt blocked by hook ${promptHook.result.sourceHookId ?? "<unknown>"}.`;
        yield emit({ type: "turn_start" });
        yield emit({ type: "text_delta", content: message });
        yield emit({ type: "turn_end", willContinue: false });
        yield emit({ type: "agent_end" });
        return;
      }
      this.injectHookModelContext(promptHook.result);
      this.appendMessage({ role: "user", content: userInput });
    }
    await hookBus.runBeforeTurn({
      agent: this,
      cwd,
      input: userInput,
      state: hookState,
      queueReminder,
      flushReminders: flushGovernorReminders,
    });
    flushGovernorReminders();

    let consecutiveOverflowRecoveries = 0;
    let consecutiveEmptyAssistantRecoveries = 0;
    let consecutiveStreamInterruptionRetries = 0;
    let step = 0;
    let autoServersStopped = false;
    const stopOwnedAutoServers = async () => {
      if (autoServersStopped) return;
      autoServersStopped = true;
      await stopAutoServersForSession(this.sessionID);
    };

    let currentAssistantMsg: Extract<Message, { role: "assistant" }> | undefined;
    let currentAssistantAppended = false;

    try {
      while (true) {
      throwIfAborted(abortSignal);
      flushGovernorReminders();
      // Background child completions surface before the next inference turn
      // without requiring a wait_agent call (design §5).
      this.flushSubagentIngestions();
      this.flushWorkflowDeliveries();
      for (const update of this.drainSubagentToolUpdates()) yield emit(update);
      for (const event of await applyPendingInputs()) yield emit(event);
      yield emit({ type: "turn_start" });
      step += 1;
      (hookState as any).turnCount = step;
      if (this.taskBudget) {
        (hookState as any).taskBudget = {
          total: this.taskBudget.total,
          spent: (hookState as any).taskBudget?.spent ?? 0,
        };
      }
      let forceTextOnlyReason = (hookState as any).forceTextOnlyReason as string | undefined;
      if (!forceTextOnlyReason && this.maxTurns !== undefined && step >= this.maxTurns) {
        forceTextOnlyReason = "The configured maximum turns for this agent have been reached.";
        (hookState as any).forceTextOnlyReason = forceTextOnlyReason;
      }
      if (forceTextOnlyReason) {
        this.injectSystemReminder(buildToolFreezeReminder(forceTextOnlyReason));
      }

      const assistantMsg: Extract<Message, { role: "assistant" }> = {
        role: "assistant",
        content: "",
        reasoning: "",
        toolCalls: [],
        model: this._model,
        providerId: this.providerId,
        modelId: this.apiModel,
      };

      const streamingToolCalls = new Map<string, { id: string; name: string; args: string; argsCorrupt?: boolean }>();
      const textSanitizer = createStreamingInternalReminderSanitizer();
      const reasoningSanitizer = createStreamingInternalReminderSanitizer();
      let turnUsage: TokenUsage | undefined;
      let assistantAppended = false;
      currentAssistantMsg = assistantMsg;
      currentAssistantAppended = false;

      let toolEntries = Array.from(this.tools.values())
        .filter((t) => !t.deferred || this.unlockedDeferred.has(t.name));
      const beforeModelCallCtx = {
        agent: this,
        cwd,
        input: userInput,
        state: hookState,
        queueReminder,
        flushReminders: flushGovernorReminders,
        toolEntries,
        disableTools: (reason: string) => {
          (hookState as any).forceTextOnlyReason = reason;
        },
      };
      await hookBus.runBeforeModelCall(beforeModelCallCtx);
      toolEntries = beforeModelCallCtx.toolEntries;
      const preModelHook = await this.runExternalHook({
        eventName: "PreModelCall",
        cwd,
        runId,
        target: this.apiModel,
        payload: {
          providerId: this.providerId,
          model: this.apiModel,
          mode: this._mode,
          toolCount: toolEntries.length,
          ...normalizeHookInput(userInput),
        },
        fullPayload: { prompt: userInput },
      }, abortSignal);
      for (const event of preModelHook.events) yield emit(event);
      this.injectHookModelContext(preModelHook.result);
      flushGovernorReminders();
      const textOnly = !!(hookState as any).forceTextOnlyReason;
      const toolDefinitions: ToolDefinition[] = toolEntries
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));

      // LLM-driven compaction runs ahead of projector's algorithmic passes. If
      // it succeeds, this.messages is replaced with [preserved system+meta] +
      // [LLM summary] + [last user msg], and the projector becomes a no-op for
      // budget. If it fails (network error, etc.), the projector's existing
      // algorithmic fallback still kicks in.
      await this.maybeCompactWithLLM();

      const bufferedStreamingToolCallIds = new Set<string>();
      const discoveryBarrier = hookState.discoveryBarrier;
      try {
        markStableCurrentToolResultsForCache(this.messages);
        const projectedMessages = projectMessages(this.messages, {
          mode: "budgeted",
          providerId: this.providerId,
          modelId: this.apiModel,
          usageAnchorTokens: this.lastInputTokens ?? undefined,
          anchorMessageCount: this.lastAnchorMessageCount ?? undefined,
        });
        const providerStartedAt = Date.now();
        let streamTextChars = 0;
        let streamReasoningChars = 0;
        let streamToolCallDeltas = 0;
        traceEvent("provider_stream_start", {
          residentMessageCount: this.messages.length,
          projectedMessageCount: projectedMessages.length,
          toolCount: toolDefinitions.length,
          thinkingLevel: this.thinkingLevel,
          mode: this._mode,
          requestFingerprint: buildProviderRequestFingerprint(
            projectedMessages,
            toolDefinitions,
            this.providerId,
            toolDefinitions.length > 0 ? (textOnly ? "none" : "auto") : undefined,
          ),
        }, traceContext);
        const stream = this.provider.streamChat(projectedMessages, {
          model: this.apiModel,
          tools: toolDefinitions,
          toolChoice: toolDefinitions.length > 0 ? (textOnly ? "none" : "auto") : undefined,
          temperature: this.temperature,
          thinkingLevel: this.thinkingLevel,
          abortSignal,
          rateLimitPolicy: this.rateLimitPolicy,
        });

        for await (const chunk of stream) {
          throwIfAborted(abortSignal);
          switch (chunk.type) {
            case "text":
              {
                const sanitizedDelta = textSanitizer.push(chunk.content);
                if (sanitizedDelta) {
                  assistantMsg.content += sanitizedDelta;
                  streamTextChars += sanitizedDelta.length;
                  yield emit({ type: "text_delta", content: sanitizedDelta });
                }
              }
              break;
            case "reasoning_delta":
              {
                const sanitizedDelta = reasoningSanitizer.push(chunk.content);
                if (sanitizedDelta) {
                  debugReasoningStream({
                    stage: "agent_receive",
                    providerId: this._providerId,
                    modelId: this.apiModel,
                    turnStep: step,
                    beforeLength: assistantMsg.reasoning?.length ?? 0,
                    delta: summarizeDebugText(sanitizedDelta),
                    afterLength: (assistantMsg.reasoning?.length ?? 0) + sanitizedDelta.length,
                  });
                  assistantMsg.reasoning = (assistantMsg.reasoning || "") + sanitizedDelta;
                  streamReasoningChars += sanitizedDelta.length;
                  yield emit({ type: "reasoning_delta", content: sanitizedDelta });
                }
              }
              break;

            case "provider_content_block":
              appendProviderContentBlock(assistantMsg, chunk.provider, chunk.block);
              break;

            case "tool_call":
              // `toolChoice: "none"` is a governance boundary, not merely a
              // provider hint. Ignore any provider-side violation so a forced
              // text-only turn can never reach the tool execution path.
              if (textOnly) {
                traceEvent("text_only_tool_call_ignored", {
                  id: chunk.id,
                  name: chunk.name,
                  isStart: chunk.isStart,
                  isEnd: chunk.isEnd,
                }, traceContext);
                break;
              }
              if (
                discoveryBarrier?.isEnabled()
                && (bufferedStreamingToolCallIds.has(chunk.id) || discoveryBarrier.shouldBufferStreamingToolCall(chunk.name))
              ) {
                bufferedStreamingToolCallIds.add(chunk.id);
              }
              if (chunk.isStart) {
                streamingToolCalls.set(chunk.id, { id: chunk.id, name: chunk.name, args: "" });
                if (!bufferedStreamingToolCallIds.has(chunk.id)) {
                  yield emit({ type: "tool_call_start", id: chunk.id, name: chunk.name });
                }
              }
              if (!streamingToolCalls.has(chunk.id)) {
                streamingToolCalls.set(chunk.id, { id: chunk.id, name: chunk.name, args: "" });
              }
              const currentToolCall = streamingToolCalls.get(chunk.id);
              if (currentToolCall) {
                currentToolCall.name = chunk.name || currentToolCall.name;
                currentToolCall.args += chunk.arguments;
                if (chunk.argumentsFull !== undefined) {
                  currentToolCall.args = chunk.argumentsFull;
                }
                if (chunk.argumentsCorrupt) {
                  currentToolCall.argsCorrupt = true;
                }
                if (chunk.arguments) {
                  streamToolCallDeltas += 1;
                  if (!bufferedStreamingToolCallIds.has(chunk.id)) {
                    yield emit({
                      type: "tool_call_delta",
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      argumentsDelta: chunk.arguments,
                      arguments: currentToolCall.args,
                    });
                  }
                }
              }
              if (chunk.isEnd && currentToolCall) {
                assistantMsg.toolCalls!.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  arguments: currentToolCall.args,
                  ...(currentToolCall.argsCorrupt ? { argsCorrupt: true } : {}),
                });
                if (!bufferedStreamingToolCallIds.has(chunk.id)) {
                  yield emit({
                    type: "tool_call_end",
                    id: currentToolCall.id,
                    name: currentToolCall.name,
                    arguments: currentToolCall.args,
                  });
                }
                streamingToolCalls.delete(chunk.id);
              }
              break;

            case "usage":
              turnUsage = chunk.usage;
              assistantMsg.usage = chunk.usage;
              this.budgetLedger?.recordUsage(chunk.usage, this.budgetSource);
              this.lastInputTokens = chunk.usage.promptTokens;
              this.lastAnchorMessageCount = this.messages.length;
              if ((hookState as any).taskBudget) {
                (hookState as any).taskBudget.spent += chunk.usage.promptTokens + chunk.usage.completionTokens;
                if ((hookState as any).taskBudget.spent >= (hookState as any).taskBudget.total) {
                  (hookState as any).forceTextOnlyReason = "The configured task budget for this agent has been exhausted.";
                }
              }
              break;
          }
          for (const update of this.drainSubagentToolUpdates()) yield emit(update);
        }
        const flushedText = textSanitizer.flush();
        if (flushedText) {
          assistantMsg.content += flushedText;
          streamTextChars += flushedText.length;
          yield emit({ type: "text_delta", content: flushedText });
        }

        const flushedReasoning = reasoningSanitizer.flush();
        if (flushedReasoning) {
          debugReasoningStream({
            stage: "agent_receive_flush",
            providerId: this._providerId,
            modelId: this.apiModel,
            turnStep: step,
            beforeLength: assistantMsg.reasoning?.length ?? 0,
            delta: summarizeDebugText(flushedReasoning),
            afterLength: (assistantMsg.reasoning?.length ?? 0) + flushedReasoning.length,
          });
          assistantMsg.reasoning = (assistantMsg.reasoning || "") + flushedReasoning;
          streamReasoningChars += flushedReasoning.length;
          yield emit({ type: "reasoning_delta", content: flushedReasoning });
        }
        traceEvent("provider_stream_end", {
          elapsedMs: Date.now() - providerStartedAt,
          textChars: streamTextChars,
          reasoningChars: streamReasoningChars,
          toolCallDeltas: streamToolCallDeltas,
          toolCalls: assistantMsg.toolCalls?.length ?? 0,
          usage: turnUsage,
        }, traceContext);

        throwIfAborted(abortSignal);
        const assistantHasContent = assistantMsg.content.trim().length > 0;
        const assistantHasToolCalls = !!assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0;
        if (!assistantHasContent && !assistantHasToolCalls) {
          if (consecutiveEmptyAssistantRecoveries < MAX_EMPTY_ASSISTANT_RECOVERIES) {
            consecutiveEmptyAssistantRecoveries += 1;
            this.injectSystemReminder(EMPTY_ASSISTANT_RECOVERY_REMINDER);
            yield emit({ type: "turn_end", usage: turnUsage, willContinue: true });
            continue;
          }

          assistantMsg.content = EMPTY_ASSISTANT_FALLBACK;
          assistantMsg.reasoning = "";
          yield emit({ type: "text_delta", content: assistantMsg.content });
        }

        this.appendMessage(assistantMsg);
        assistantAppended = true;
        currentAssistantAppended = true;
      } catch (error) {
        traceEvent("provider_stream_error", {
          error: summarizeTraceError(error),
        }, traceContext);
        if (assistantAppended) {
          throw error;
        }
        if (
          isProviderStreamInterruption(error)
          && !isAbortLikeError(error, abortSignal)
          && consecutiveStreamInterruptionRetries < MAX_STREAM_INTERRUPTION_RETRIES
        ) {
          // The provider stream died after partial content. The half-built
          // assistantMsg was never appended to this.messages, and the next
          // turn_start resets the streaming display, so re-issuing the whole
          // request is safe.
          consecutiveStreamInterruptionRetries += 1;
          yield emit({
            type: "provider_retry",
            attempt: consecutiveStreamInterruptionRetries,
            maxAttempts: MAX_STREAM_INTERRUPTION_RETRIES,
            reason: "Provider stream interrupted mid-response.",
          });
          await sleepBeforeRetry(
            computeRetryDelayMs(consecutiveStreamInterruptionRetries),
            abortSignal,
          ).catch(() => undefined);
          continue;
        }
        if (!isContextOverflowError(error)) {
          if (!isAbortLikeError(error, abortSignal) && shouldAppendModelInterruptedBoundary(this.messages)) {
            this.appendMessage(createModelInterruptedMessage(error, {
              model: this._model,
              providerId: this.providerId,
              modelId: this.apiModel,
            }));
            assistantAppended = true;
          }
          throw error;
        }
        if (consecutiveOverflowRecoveries >= MAX_CONSECUTIVE_OVERFLOW_RECOVERIES) {
          throw error;
        }
        const droppedMessages = await this.recoverFromOverflow(consecutiveOverflowRecoveries);
        consecutiveOverflowRecoveries += 1;
        yield emit({ type: "context_recovered", droppedMessages, reason: "overflow" });
        continue;
      }

      consecutiveOverflowRecoveries = 0;
      consecutiveEmptyAssistantRecoveries = 0;
      consecutiveStreamInterruptionRetries = 0;

      // Execute tools if any
      if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
        const parsedCalls: Array<ParsedToolCall & { arbiterNote?: string }> = [];
        for (let index = 0; index < assistantMsg.toolCalls.length; index++) {
          const tc = assistantMsg.toolCalls[index];
          try {
            parsedCalls.push({
              ...tc,
              parsedArgs: JSON.parse(tc.arguments),
              ...(tc.argsCorrupt ? { argsCorrupt: true } : {}),
            });
          } catch {
            parsedCalls.push({ ...tc, parsedArgs: {}, argsCorrupt: true });
          }
        }
        const orderedCalls = hookState.discoveryBarrier?.orderToolCalls(parsedCalls) ?? parsedCalls;
        if (orderedCalls !== parsedCalls) {
          parsedCalls.splice(0, parsedCalls.length, ...orderedCalls);
          assistantMsg.toolCalls = parsedCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            ...(tc.argsCorrupt ? { argsCorrupt: true } : {}),
          }));
        }

        const executedResults: ToolResult[] = [];
        const appendCancelledToolMessages = (startIndex: number) => {
          for (let pendingIndex = startIndex; pendingIndex < parsedCalls.length; pendingIndex++) {
            const pending = parsedCalls[pendingIndex];
            const pendingResult = cancelledToolResult(pending.name);
            this.appendMessage({
              role: "tool",
              toolCallId: pending.id,
              content: pendingResult.content,
              metadata: pendingResult.metadata,
              isError: pendingResult.isError,
            });
            executedResults.push(pendingResult);
          }
        };
        for (let index = 0; index < parsedCalls.length; index++) {
          if (abortSignal?.aborted) {
            appendCancelledToolMessages(index);
            throwIfAborted(abortSignal);
          }
          let tc = parsedCalls[index];
          let blockedResult: ToolResult | undefined;
          // run_workflow must be the only tool call in its response: it starts
          // a background orchestration whose result lands next turn, and
          // sibling calls racing it defeat the serialized fan-out contract.
          if (tc.name === "run_workflow" && parsedCalls.length > 1) {
            blockedResult = {
              content: [
                "run_workflow must be the only tool call in your response.",
                "Re-issue run_workflow alone — one call, nothing else in the same message — and run other tools after it returns.",
              ].join(" "),
              isError: true,
              status: "blocked",
            };
          }
          await hookBus.runBeforeToolCall({
            agent: this,
            cwd,
            input: userInput,
            state: hookState,
            queueReminder,
            flushReminders: flushGovernorReminders,
            toolCall: tc,
            blockedResult,
            replaceToolCall: (toolCall) => {
              tc = toolCall;
            },
            blockToolCall: (result) => {
              blockedResult = result;
            },
          });
          const preToolHook = await this.runExternalHook({
            eventName: "PreToolUse",
            cwd,
            runId,
            target: tc.name,
            payload: {
              id: tc.id,
              name: tc.name,
              argsPreview: truncateHookText(tc.arguments, 1000),
            },
            fullPayload: {
              toolArgs: tc.parsedArgs,
              toolArguments: tc.arguments,
            },
          }, abortSignal);
          for (const event of preToolHook.events) yield emit(event);
          this.injectHookModelContext(preToolHook.result);
          if (preToolHook.result.decision === "deny") {
            blockedResult = {
              content: preToolHook.result.reason
                ?? `Tool call blocked by hook ${preToolHook.result.sourceHookId ?? "<unknown>"}.`,
              isError: true,
              metadata: {
                hook: {
                  eventName: "PreToolUse",
                  hookId: preToolHook.result.sourceHookId,
                },
              },
            };
          }
          assistantMsg.toolCalls[index] = {
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          };
          flushGovernorReminders();
          if (bufferedStreamingToolCallIds.has(tc.id) && !isHiddenToolResult(blockedResult)) {
            yield emit({ type: "tool_call_start", id: tc.id, name: tc.name });
            if (tc.arguments) {
              yield emit({
                type: "tool_call_delta",
                id: tc.id,
                name: tc.name,
                argumentsDelta: tc.arguments,
                arguments: tc.arguments,
              });
            }
            yield emit({ type: "tool_call_end", id: tc.id, name: tc.name, arguments: tc.arguments });
          }
          if (isHiddenToolResult(blockedResult)) {
            let result = blockedResult;
            await hookBus.runAfterToolCall({
              agent: this,
              cwd,
              input: userInput,
              state: hookState,
              queueReminder,
              flushReminders: flushGovernorReminders,
              toolCall: tc,
              result,
              replaceResult: (next) => {
                result = next;
              },
            });
            const postToolHook = await this.runExternalHook({
              eventName: result.isError ? "PostToolUseFailure" : "PostToolUse",
              cwd,
              runId,
              target: tc.name,
              payload: {
                id: tc.id,
                name: tc.name,
                argsPreview: truncateHookText(tc.arguments, 1000),
                resultPreview: truncateHookText(result.content, 1000),
                isError: result.isError === true,
              },
              fullPayload: {
                toolArgs: tc.parsedArgs,
                toolArguments: tc.arguments,
                toolResult: result,
              },
            }, abortSignal);
            for (const event of postToolHook.events) yield emit(event);
            this.injectHookModelContext(postToolHook.result);
            traceEvent("speculative_read_blocked", {
              id: tc.id,
              name: tc.name,
              args: summarizeTraceValue(tc.parsedArgs),
              result: summarizeTraceToolResult(result),
            }, traceContext);
            this.appendMessage({
              role: "tool",
              toolCallId: tc.id,
              content: result.content,
              metadata: result.metadata,
              isError: result.isError,
            });
            executedResults.push(result);
            flushGovernorReminders();
            continue;
          }
          const toolStartedAt = Date.now();
          traceEvent("tool_execute_start", {
            id: tc.id,
            name: tc.name,
            args: summarizeTraceValue(tc.parsedArgs),
            argsCorrupt: tc.argsCorrupt,
          }, traceContext);
          yield emit({ type: "tool_start", id: tc.id, name: tc.name, args: tc.parsedArgs });
          const todosVersionBefore = this._todosVersion;
          const modeVersionBefore = this._modeVersion;
          const updateQueue = createUpdateQueue<ToolUpdate>();
          let result: ToolResult;
          if (blockedResult) {
            result = blockedResult;
          } else {
            const toolExecution = this.executeTool(tc, cwd, abortSignal, (update) => updateQueue.push(update));
            let settled = false;
            let cancelledByAbort = false;
            let resolved: ToolResult | undefined;
            let rejected: unknown;
            void toolExecution
              .then((value) => {
                resolved = value;
              })
              .catch((error) => {
                rejected = error;
              })
              .finally(() => {
                settled = true;
                updateQueue.wake();
              });

            this.subagentUpdateWakers.add(updateQueue.wake);
            try {
              while (!settled || updateQueue.hasItems() || this.pendingSubagentUpdates.length > 0) {
                for (const update of updateQueue.drain()) {
                  yield emit({ type: "tool_update", id: tc.id, name: tc.name, update });
                }
                for (const update of this.drainSubagentToolUpdates()) yield emit(update);
                // A wake() that fires while this generator is suspended at a
                // yield above finds no parked waiter and is lost (the queue has
                // no wake latch), so re-check the subagent queue synchronously
                // before parking — otherwise an update pushed during the yield
                // stalls until the next unrelated wake or the tool settles.
                if (!settled && this.pendingSubagentUpdates.length === 0) {
                  const waitStatus = await updateQueue.wait(abortSignal);
                  if (waitStatus === "aborted" && !settled) {
                    cancelledByAbort = true;
                    break;
                  }
                }
              }
            } finally {
              this.subagentUpdateWakers.delete(updateQueue.wake);
            }
            if (cancelledByAbort) {
              result = cancelledToolResult(tc.name);
            } else {
              if (rejected) throw rejected;
              result = resolved ?? { content: `Error: Tool "${tc.name}" returned no result`, isError: true };
            }
          }
          await hookBus.runAfterToolCall({
            agent: this,
            cwd,
            input: userInput,
            state: hookState,
            queueReminder,
            flushReminders: flushGovernorReminders,
            toolCall: tc,
            result,
            replaceResult: (next) => {
              result = next;
            },
          });
          const postToolHook = await this.runExternalHook({
            eventName: result.isError ? "PostToolUseFailure" : "PostToolUse",
            cwd,
            runId,
            target: tc.name,
            payload: {
              id: tc.id,
              name: tc.name,
              argsPreview: truncateHookText(tc.arguments, 1000),
              resultPreview: truncateHookText(result.content, 1000),
              isError: result.isError === true,
            },
            fullPayload: {
              toolArgs: tc.parsedArgs,
              toolArguments: tc.arguments,
              toolResult: result,
            },
          }, abortSignal);
          for (const event of postToolHook.events) yield emit(event);
          this.injectHookModelContext(postToolHook.result);
          // Honor the model's server-declared per-tool-output token cap (e.g.
          // gpt-5.5 reports 10000). Without this, 4-5 large file reads in a row
          // blow past the input window even though our local estimate looks fine.
          const truncatedOutput = truncateToolOutputForModel(
            result.content,
            this.providerId,
            this.apiModel,
          );
          traceEvent("tool_execute_end", {
            id: tc.id,
            name: tc.name,
            elapsedMs: Date.now() - toolStartedAt,
            result: summarizeTraceToolResult(result),
            outputTruncation: {
              truncated: truncatedOutput.truncated,
              originalTokens: truncatedOutput.originalTokens,
              finalTokens: truncatedOutput.finalTokens,
              limit: truncatedOutput.limit,
            },
          }, traceContext);
          this.appendMessage({
            role: "tool",
            toolCallId: tc.id,
            content: truncatedOutput.content,
            metadata: result.metadata,
            isError: result.isError,
          });
          this.compactResidentHistory();
          flushGovernorReminders();
          this.onToolResult?.(tc.name, result);
          executedResults.push(result);
          yield emit({ type: "tool_end", id: tc.id, name: tc.name, result });
          for (const update of this.drainSubagentToolUpdates()) yield emit(update);
          if (this._todosVersion !== todosVersionBefore) {
            yield emit({ type: "todos_updated", todos: this.getTodos() });
          }
          if (this._modeVersion !== modeVersionBefore) {
            yield emit({ type: "mode_changed", mode: this._mode });
          }
          if (abortSignal?.aborted) {
            appendCancelledToolMessages(index + 1);
            throwIfAborted(abortSignal);
          }
        }

        await hookBus.runBeforeContinuation({
          agent: this,
          cwd,
          input: userInput,
          state: hookState,
          queueReminder,
          flushReminders: flushGovernorReminders,
          toolCalls: parsedCalls,
          toolResults: executedResults,
          requestTextOnlyTurn: (reason: string) => {
            (hookState as any).forceTextOnlyReason = reason;
          },
        });
        flushGovernorReminders();

        yield emit({ type: "turn_end", usage: turnUsage, willContinue: true });

        // Auto-continue: if we have tool results, the LLM needs to respond to them.
        // Emitting the turn boundary keeps UI renderers aligned with the persisted
        // assistant/tool message sequence instead of merging the next answer into
        // the tool-call turn.
        continue;
      }

      await hookBus.runAfterTurn({
        agent: this,
        cwd,
        input: userInput,
        state: hookState,
        queueReminder,
        flushReminders: flushGovernorReminders,
      });
      flushGovernorReminders();
      const stopHook = await this.runExternalHook({
        eventName: "Stop",
        cwd,
        runId,
        target: "turn",
        payload: {
          providerId: this.providerId,
          model: this.apiModel,
          mode: this._mode,
          assistantChars: assistantMsg.content.length,
          toolCalls: assistantMsg.toolCalls?.length ?? 0,
        },
      }, abortSignal);
      for (const event of stopHook.events) yield emit(event);
      const willContinue = !!(hookState as any).forceContinuationReason;
      yield emit({ type: "turn_end", usage: turnUsage, willContinue });
      if (willContinue) {
        delete (hookState as any).forceContinuationReason;
        continue;
      }
      for (const event of await rejectPendingInputs("no_continuation")) yield emit(event);
      break;
    }

      for (const update of this.drainSubagentToolUpdates()) yield emit(update);
      await stopOwnedAutoServers();
      yield emit({ type: "agent_end" });
    } catch (error) {
      if (isAbortError(error, abortSignal)) {
        const appendedBoundary = this.appendInterruptedAssistantBoundary(
          currentAssistantMsg,
          currentAssistantAppended,
        );
        const clearedTodos = this.clearTodosAfterInterruptedRun();
        traceEvent("agent_run_interrupted", {
          appendedBoundary,
          clearedTodos,
          messageCount: this.messages.length,
        }, traceContext);
        if (clearedTodos) {
          yield emit({ type: "todos_updated", todos: this.getTodos() });
        }
      } else {
        const stopFailureHook = await this.runExternalHook({
          eventName: "StopFailure",
          cwd,
          runId,
          target: "run_error",
          payload: {
            error: summarizeTraceError(error),
          },
        }, abortSignal);
        for (const event of stopFailureHook.events) yield emit(event);
      }
      throw error;
    } finally {
      await stopOwnedAutoServers();
      traceEvent("agent_run_end", {
        messageCount: this.messages.length,
      }, traceContext);
    }
  }

  private async recoverFromOverflow(attempt: number): Promise<number> {
    const before = this.messages.length;
    const beforeTokens = this.messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);

    if (attempt === 0) {
      this.messages = aggressivePruneMessages(this.messages);
      const afterTokens = this.messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
      if (afterTokens < beforeTokens) {
        this.lastInputTokens = null;
        this.lastAnchorMessageCount = null;
        this.fileStateTracker?.invalidateReadHistory();
        return before - this.messages.length;
      }
    }

    const keepRecentTurns = attempt >= 2 ? 1 : 2;
    const llmResult = await compactMessagesWithLLM(this.messages, {
      provider: this.provider,
      model: this.apiModel,
      thinkingLevel: this.thinkingLevel,
      keepRecentTurns,
    });
    if (llmResult.compacted && llmResult.messages) {
      this.messages = llmResult.messages;
      this.lastInputTokens = null;
      this.lastAnchorMessageCount = null;
      this.fileStateTracker?.invalidateReadHistory();
      return before - this.messages.length;
    }

    // Single-turn capable LLM compactor. compactMessagesWithLLM above no-ops
    // when there's only one user turn (the "single huge prompt with many tool
    // calls" case), so try the turn-internal compactor before giving up.
    const { compactWithLLM } = await import("./context/llm-compactor.js");
    const singleTurnResult = await compactWithLLM(this.messages, {
      provider: this.provider,
      modelId: this.apiModel,
    });
    if (singleTurnResult.compacted && singleTurnResult.messages) {
      this.messages = singleTurnResult.messages;
      this.lastInputTokens = null;
      this.lastAnchorMessageCount = null;
      this.fileStateTracker?.invalidateReadHistory();
      return before - this.messages.length;
    }

    const fallback = compactMessages(this.messages, { keepRecentTurns });
    if (fallback.compacted && fallback.messages) {
      this.messages = fallback.messages;
      this.lastInputTokens = null;
      this.lastAnchorMessageCount = null;
      this.fileStateTracker?.invalidateReadHistory();
      return before - this.messages.length;
    }

    // Codex-style last-resort: drop the single oldest non-protected message
    // and let the retry loop try again. Cheap, but eventually narrows even an
    // intractable single-turn overflow.
    const oldestIdx = this.messages.findIndex(
      (m) => m.role !== "system" && m.role !== "meta",
    );
    if (oldestIdx >= 0 && oldestIdx < this.messages.length - 1) {
      this.messages = [
        ...this.messages.slice(0, oldestIdx),
        ...this.messages.slice(oldestIdx + 1),
      ];
      this.lastInputTokens = null;
      this.lastAnchorMessageCount = null;
      this.fileStateTracker?.invalidateReadHistory();
      return before - this.messages.length;
    }

    return 0;
  }

  compactResidentHistory(): void {
    this.maybeCompactResidentHistory();
  }

  private async maybeCompactWithLLM(): Promise<void> {
    if (!this.providerId || !this.apiModel) return;
    if (this.messages.length === 0) return;

    const tail = this.lastAnchorMessageCount !== null
      ? this.messages.slice(this.lastAnchorMessageCount)
      : undefined;
    const budget = getContextBudget(this.providerId, this.apiModel, this.messages, {
      usageAnchorTokens: this.lastInputTokens ?? undefined,
      tailMessages: tail,
    });
    if (!budget.shouldCompact) return;

    const { compactWithLLM } = await import("./context/llm-compactor.js");
    const result = await compactWithLLM(this.messages, {
      provider: this.provider,
      modelId: this.apiModel,
    });
    if (result.compacted && result.messages) {
      this.messages = result.messages;
      this.lastInputTokens = null;
      this.lastAnchorMessageCount = null;
      this.fileStateTracker?.invalidateReadHistory();
    }
    // If LLM compaction failed for any reason, leave this.messages alone —
    // the projector's algorithmic budgeted-mode passes will still try.
  }

  /**
   * Stream a 9-section handoff summary of `oldMessages` from the session model.
   * Powers the manual `/compact` command: streaming (rather than `complete()`)
   * is what lets the TUI show live progress as the summary is produced.
   *
   * `onDelta` receives the full accumulated text and the latest delta on each
   * chunk. Returns the trimmed summary, or "" if the model produced nothing
   * (the caller falls back to heuristic compaction in that case). Throws only
   * if the provider stream itself errors.
   */
  async summarizeForCompaction(
    oldMessages: Message[],
    onDelta?: (full: string, delta: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    if (oldMessages.length === 0) return "";
    const { buildCompactionPromptMessages } = await import("./context/compact-llm.js");
    const promptMessages = buildCompactionPromptMessages(oldMessages);
    const stream = this.provider.streamChat(promptMessages, {
      model: this.apiModel,
      temperature: 0.2,
      thinkingLevel: "off",
      abortSignal,
    });
    let full = "";
    for await (const chunk of stream) {
      if (chunk.type === "text" && chunk.content) {
        full += chunk.content;
        onDelta?.(full, chunk.content);
      }
    }
    // Strip any internal reminder markup the summarizer may have reproduced from
    // the transcript: this summary is both displayed in the compaction card and
    // re-injected as a `Previous conversation summary` system message.
    return sanitizeInternalReminderBlocks(full).trim();
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
      route: options.route ?? this.resolveRouteForSubagent(options.profile, options.category),
    });
    this.subagentStore.set(record);
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
      ?? this.resolveRouteForSubagent(options.profile, options.category, { model: options.model, effort: options.effort });
    // Early validation (design §7): throws reach the model as a tool error it
    // can correct this turn, instead of a late provider-factory failure.
    const routeNote = this.validateRouteForDispatch(route);
    this.noteRoutingDispatch(route);
    const record = this.createSubagentThreadRecord({
      profile: options.profile,
      task: typeof input === "string" ? input : "(multimodal task)",
      parentToolCallId: options.parentToolCallId,
      parentToolName: "spawn_agent",
      route,
    });
    if (routeNote) record.toolNotes.push(routeNote);
    this.subagentStore.set(record);
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
    void record.promise.finally(() => this.subagentStore.notifyWaiters(record));
    return this.snapshotSubagent(record);
  }

  async waitSubAgents(options: { agentIds?: string[]; timeoutMs?: number } = {}): Promise<SubagentThreadSnapshot[]> {
    const targets = this.resolveSubagentTargets(options.agentIds);
    if (targets.length === 0) return [];
    const completed = targets.filter((record) => isFinalSubagentStatus(record.status));
    if (completed.length > 0) {
      for (const record of completed) this.subagentStore.markDelivered(record.agentId);
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
    for (const record of finished) this.subagentStore.markDelivered(record.agentId);
    return (finished.length > 0 ? finished : targets).map((record) => this.snapshotSubagent(record));
  }

  async sendSubAgentInput(
    agentId: string,
    input: string | ContentPart[],
    cwd: string,
    options: { interrupt?: boolean; parentToolCallId?: string; abortSignal?: AbortSignal } = {},
  ): Promise<SubagentThreadSnapshot> {
    const record = this.subagentStore.get(agentId);
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
    // A send_input restart is a launch like any other: it goes through the
    // scheduler's dispatch point and is subject to the same admission limits
    // (design §4.1) — batch-resuming team members cannot bypass concurrency caps.
    record.promise = this.dispatchSubagentRun(record, input, cwd, {
      approval: record.profile.approval,
      abortSignal: options.abortSignal,
      queueUpdates: true,
      reuseAgent: true,
    });
    void record.promise.finally(() => this.subagentStore.notifyWaiters(record));
    return this.snapshotSubagent(record);
  }

  async closeSubAgent(agentId: string): Promise<SubagentThreadSnapshot> {
    const record = this.subagentStore.get(agentId);
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
    this.subagentStore.persist(record);
    this.subagentStore.notifyWaiters(record);
    return this.snapshotSubagent(record);
  }

  listSubAgents(): SubagentThreadSnapshot[] {
    return this.subagentStore.values()
      .filter((record) => !record.workflowInternal)
      .map((record) => this.snapshotSubagent(record));
  }

  /**
   * Dynamic workflow (option C): runs an LLM-authored JS orchestration script in
   * a QuickJS sandbox. Each agent() call in the script becomes a real scheduled
   * subagent (same route resolution, ChildRunner, scheduler, schema validation
   * as spawn_agent), so the script expresses deterministic control flow while
   * the runtime keeps owning concurrency/budget/retry.
   *
   * Foreground entry point (used by `-p`/headless and tests): awaits to
   * completion and returns the result. Background runs go through startWorkflow.
   */
  async runWorkflow(
    cwd: string,
    options: {
      script: string;
      args?: unknown;
      parentToolCallId: string;
      emitUpdate?: (update: ToolUpdate) => void;
      abortSignal?: AbortSignal;
      ensureProfileTrusted?: (profile: AgentProfile) => Promise<{ content: string | unknown } | undefined>;
    },
  ): Promise<{ result: { ok: true; value: unknown } | { ok: false; error: string }; agentCount: number; logs: string[]; snapshots: SubagentThreadSnapshot[] }> {
    return this.executeWorkflow(cwd, {
      script: options.script,
      args: options.args,
      parentToolCallId: options.parentToolCallId,
      abortSignal: options.abortSignal,
      directEmit: options.emitUpdate,
      ensureProfileTrusted: options.ensureProfileTrusted,
    });
  }

  /**
   * Starts a workflow in the BACKGROUND (option C Phase 4): returns a runId
   * immediately; the script runs detached, its agents stream progress through
   * the queued channel (drained at turn boundaries like spawn_agent), and its
   * result is ingested at the next turn. Collect explicitly with waitWorkflow.
   */
  startWorkflow(
    cwd: string,
    options: {
      script: string;
      args?: unknown;
      title?: string;
      parentToolCallId: string;
      abortSignal?: AbortSignal;
      ensureProfileTrusted?: (profile: AgentProfile) => Promise<{ content: string | unknown } | undefined>;
    },
  ): { runId: string; title: string } {
    const runId = randomUUID();
    const abortController = new AbortController();
    const composed = composeAbortSignals([options.abortSignal, abortController.signal]);
    if (composed) {
      composed.addEventListener("abort", () => abortController.abort(composed.reason), { once: true });
    }
    const record: WorkflowRunRecord = {
      runId,
      title: options.title ?? "workflow",
      status: "running",
      agentCount: 0,
      snapshots: [],
      logs: [],
      abortController,
      waiters: new Set(),
      createdAt: Date.now(),
      parentToolCallId: options.parentToolCallId,
    };
    this.workflowRuns.set(runId, record);
    record.promise = this.executeWorkflow(cwd, {
      script: options.script,
      args: options.args,
      parentToolCallId: options.parentToolCallId,
      abortSignal: abortController.signal,
      queueUpdates: true,
      ensureProfileTrusted: options.ensureProfileTrusted,
    }).then((out) => {
      record.agentCount = out.agentCount;
      record.snapshots = out.snapshots;
      record.logs = out.logs;
      record.result = out.result;
      record.status = out.result.ok ? "completed" : (abortController.signal.aborted ? "cancelled" : "failed");
      if (out.result.ok) record.resultPath = persistWorkflowResult(runId, out.result.value);
    }, (error: any) => {
      record.result = { ok: false, error: error?.message || String(error) };
      record.status = "failed";
    }).finally(() => {
      record.updatedAt = Date.now();
      this.pendingWorkflowDeliveries.add(runId);
      for (const waiter of record.waiters) waiter();
      record.waiters.clear();
    });
    return { runId, title: record.title };
  }

  /** Blocks until a background workflow reaches a final state (or times out). */
  async waitWorkflow(runId: string, timeoutMs?: number): Promise<WorkflowRunSnapshot | undefined> {
    const record = this.workflowRuns.get(runId);
    if (!record) return undefined;
    if (record.status === "running") {
      const limit = normalizeWaitTimeout(timeoutMs);
      let waiter: (() => void) | undefined;
      await Promise.race([
        new Promise<void>((resolve) => { waiter = resolve; record.waiters.add(resolve); }),
        new Promise<void>((resolve) => setTimeout(resolve, limit)),
      ]).finally(() => { if (waiter) record.waiters.delete(waiter); });
    }
    if (record.status !== "running") this.pendingWorkflowDeliveries.delete(runId);
    return this.snapshotWorkflow(record);
  }

  /** Cancels a running background workflow. */
  closeWorkflow(runId: string): WorkflowRunSnapshot | undefined {
    const record = this.workflowRuns.get(runId);
    if (!record) return undefined;
    if (record.status === "running") record.abortController.abort(new Error("workflow cancelled"));
    return this.snapshotWorkflow(record);
  }

  listWorkflows(): WorkflowRunSnapshot[] {
    return [...this.workflowRuns.values()].map((record) => this.snapshotWorkflow(record));
  }

  private snapshotWorkflow(record: WorkflowRunRecord): WorkflowRunSnapshot {
    return {
      runId: record.runId,
      title: record.title,
      status: record.status,
      agentCount: record.agentCount,
      result: record.result,
      resultPath: record.resultPath,
      logs: record.logs,
      snapshots: record.snapshots,
    };
  }

  /** Injects completed background-workflow results before the next turn (§5 analog). */
  private flushWorkflowDeliveries(): void {
    if (this.pendingWorkflowDeliveries.size === 0) return;
    for (const runId of [...this.pendingWorkflowDeliveries]) {
      this.pendingWorkflowDeliveries.delete(runId);
      const record = this.workflowRuns.get(runId);
      if (!record || record.status === "running" || record.deliveredAt) continue;
      record.deliveredAt = Date.now();
      this.injectSystemReminder(buildWorkflowDeliveryNotice(this.snapshotWorkflow(record)));
    }
  }

  private async executeWorkflow(
    cwd: string,
    options: {
      script: string;
      args?: unknown;
      parentToolCallId: string;
      abortSignal?: AbortSignal;
      directEmit?: (update: ToolUpdate) => void;
      queueUpdates?: boolean;
      ensureProfileTrusted?: (profile: AgentProfile) => Promise<{ content: string | unknown } | undefined>;
    },
  ): Promise<{ result: { ok: true; value: unknown } | { ok: false; error: string }; agentCount: number; logs: string[]; snapshots: SubagentThreadSnapshot[] }> {
    const profiles = discoverAgentProfiles(cwd, "both").profiles;
    const runRecords: SubagentThreadRecord[] = [];
    const logs: string[] = [];

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
        route = this.resolveRouteForSubagent(profile, spec.opts.category, {
          model: spec.opts.model,
          effort: parseThinkingLevel(spec.opts.effort),
        });
        // Dispatch-time validation + defaulted-fan-out accounting (§6–7):
        // resolved routes, never script source text.
        routeNote = this.validateRouteForDispatch(route);
        this.noteRoutingDispatch(route);
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
        route,
        workflowInternal: true,
      });
      record.expectsStructuredOutput = spec.opts.schema !== undefined;
      if (routeNote) record.toolNotes.push(routeNote);
      const memberLabel = typeof spec.opts.label === "string" ? spec.opts.label.trim().slice(0, 40) : "";
      if (memberLabel) record.nickname = memberLabel;
      runRecords.push(record);
      this.subagentStore.set(record);
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
      this.subagentStore.markDelivered(record.agentId);

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
      onPhase: (title) => logs.push(`— phase: ${title} —`),
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

  /** Marks a child's full summary as delivered to parent context (design §3.3). */
  markSubagentDelivered(agentId: string): void {
    this.subagentStore.markDelivered(agentId);
  }

  private snapshotSubagent(record: SubagentThreadRecord): SubagentThreadSnapshot {
    const snapshot = snapshotSubagentThread(record);
    if (record.status === "queued") {
      const queuePosition = this.subagentScheduler.queuePosition(record.agentId);
      if (queuePosition !== undefined) return { ...snapshot, queuePosition };
    }
    return snapshot;
  }

  /** Returns the blocking diagnostic message when the profile cannot run, else undefined. */
  private admitSubagentProfile(record: SubagentThreadRecord, approval: "fail" | "disabled"): string | undefined {
    const diagnostics = validateAgentProfileTools([...this.tools.values()], record.profile, approval);
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

  private flushSubagentIngestions(): void {
    if (!this.resultIntegrator.hasPending()) return;
    for (const notice of this.resultIntegrator.drainNotices(this.subagentStore)) {
      this.injectSystemReminder(notice);
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
    this.subagentStore.persist(record);
    this.subagentStore.notifyWaiters(record);
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
    return this.subagentScheduler.dispatch({
      agentId: record.agentId,
      category: record.category,
      signal: queueSignal,
      run: (ctx) => this.runSubagentThread(record, input, cwd, { ...options, attempt: ctx.attempt }),
      onCancelledWhileQueued: (reason) => {
        record.status = "cancelled";
        record.finalReason = classifySubagentAbortReason(reason, options.abortSignal);
        record.error = reason instanceof Error ? reason.message : reason ? String(reason) : "Cancelled while queued.";
        record.updatedAt = Date.now();
        // The run never started, so no SubagentStart fired and no SubagentStop follows.
        this.emitSubagentLifecycle(record, options, "cancelled", undefined, record.error);
        this.subagentStore.persist(record);
        this.subagentStore.notifyWaiters(record);
        this.maybeEnqueueIngestion(record, options);
      },
      onRateLimitExhausted: (attempts) => {
        record.status = "failed";
        record.finalReason = "rate_limited_exhausted";
        record.error = `Provider rate limit persisted after ${attempts} attempts.`;
        record.updatedAt = Date.now();
        void this.runSubagentLifecycleHookFor(record, cwd, "SubagentStop", record.status, record.error);
        this.emitSubagentLifecycle(record, options, "failed", undefined, record.error);
        this.subagentStore.persist(record);
        this.subagentStore.notifyWaiters(record);
        this.maybeEnqueueIngestion(record, options);
      },
      onTransportRetryExhausted: (attempts) => {
        record.status = "failed";
        // failed_transient stays resumable, so the parent can still send_input
        // to recover the child with its context intact.
        record.finalReason = "failed_transient";
        record.error = `Provider transport error persisted after ${attempts} attempts.`;
        record.updatedAt = Date.now();
        void this.runSubagentLifecycleHookFor(record, cwd, "SubagentStop", record.status, record.error);
        this.emitSubagentLifecycle(record, options, "failed", undefined, record.error);
        this.subagentStore.persist(record);
        this.subagentStore.notifyWaiters(record);
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
      this.pendingSubagentUpdates.push({ id: record.parentToolCallId, name: record.parentToolName, update });
      this.wakeSubagentUpdateWaiters();
    }
  }

  /** Lets a blocked tool-execution loop drain freshly queued subagent updates. */
  private wakeSubagentUpdateWaiters(): void {
    for (const wake of this.subagentUpdateWakers) wake();
  }

  private async runSubagentLifecycleHookFor(
    record: SubagentThreadRecord,
    cwd: string,
    eventName: "SubagentStart" | "SubagentStop",
    status?: string,
    error?: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.runExternalHook({
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
    }
  }

  /**
   * Resolves a child's model route. Priority, highest first (design v2 §1.1):
   *   call-site override (model/effort)  >  profile.model  >  category  >  inherit parent.
   * The call-site override is what lets the model say "opus for this reviewer,
   * haiku for these twenty scouts" per spawn/batch member at request time.
   */
  private resolveRouteForSubagent(
    profile: AgentProfile,
    category: string | undefined,
    override?: { model?: string; effort?: ThinkingLevel },
  ): ResolvedSubagentRoute {
    const parentRoute = {
      providerId: this.providerId,
      model: this.apiModel,
      thinkingLevel: this.thinkingLevel,
    };
    const snapshot = this.currentRoutingSnapshot();
    const resolved = resolveSubagentRoute(
      category ?? profile.category,
      { ...parentRoute },
      this.agentCategories,
      snapshot ? tierContextFromSnapshot(snapshot, this.agentRouting) : undefined,
    );
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    let route = resolved.route;
    // modelSource is assigned while applying the chain (design §3.4): an
    // explicit layer naming the parent's own model is indistinguishable from
    // inherit by final-value comparison, yet carries different authority.
    let modelSource: import("./agent/categories.js").RouteModelSource =
      route.categoryModelSource ?? "inherit";
    if (profile.model && profile.model !== "inherit") {
      const model = resolveModelRoute(profile.model, parentRoute.providerId);
      if (model.model !== "inherit") {
        route = { ...route, providerId: model.providerId, model: model.model, inherited: false };
        modelSource = "profile";
      }
    }
    // Call-site override beats profile and category. Bare names resolve
    // against the PARENT provider per the tool contract (design §3.5) — not
    // against a provider that category/profile may already have switched.
    if (override?.model) {
      const model = resolveModelRoute(override.model, parentRoute.providerId);
      if (model.model !== "inherit") {
        route = { ...route, providerId: model.providerId, model: model.model, inherited: false };
        modelSource = "callsite";
      }
    }
    const supportedLevels = getAvailableThinkingLevels(route.providerId, route.model);
    const modelMetadata = getBuiltinModel(route.providerId, route.model);
    const hasTrustedEffortMetadata = !!modelMetadata
      && modelMetadata.reasoningLevels.some((level) => level !== "off");
    if (override?.effort) {
      // A call-site effort is explicit user/model intent: preserve the existing
      // value for legacy/unknown models, and downward-clamp only when the
      // catalog declares real effort capabilities (for example Luna ultra -> max).
      route = {
        ...route,
        thinkingLevel: hasTrustedEffortMetadata
          ? normalizeThinkingLevel(override.effort, supportedLevels)
          : override.effort,
        inherited: false,
      };
    } else if (hasTrustedEffortMetadata) {
      const categoryThinkingLevel = route.category
        ? mergeAgentCategories(this.agentCategories)[route.category]?.thinkingLevel
        : undefined;
      // A category's thinkingLevel is calibrated for the model the CATEGORY
      // resolved. When a later layer (profile/call-site) replaced the model,
      // that level is no longer explicit intent for the final model: keep it
      // only if supported, else use the final model's own default — never
      // downward-clamp a thinking-default model to "off" (v3.6; live case:
      // explore's "low" + call-site glm-5.2 [high/max/off] silently landed
      // on "off").
      const modelReplacedAfterCategory = modelSource === "profile" || modelSource === "callsite";
      route = {
        ...route,
        thinkingLevel: categoryThinkingLevel
          ? (modelReplacedAfterCategory && !supportedLevels.includes(route.thinkingLevel)
              ? getDefaultThinkingLevel(route.providerId, route.model)
              : normalizeThinkingLevel(route.thinkingLevel, supportedLevels))
          : normalizeInheritedThinkingLevel(route.providerId, route.model, route.thinkingLevel),
      };
    }
    return {
      ...route,
      modelSource,
      modelInherited: route.providerId === parentRoute.providerId && route.model === parentRoute.model,
    };
  }

  /** Live snapshot for the CURRENT parent route; undefined when no accessor is wired. */
  private currentRoutingSnapshot(): RoutingSnapshot | undefined {
    if (!this.routingSnapshotAccessor) return undefined;
    try {
      return this.routingSnapshotAccessor({ providerId: this.providerId, model: this.apiModel });
    } catch {
      // Catalog data is an enhancement, never a spawn blocker.
      return undefined;
    }
  }

  /**
   * Early route validation at dispatch time (design §7). Throws with an
   * actionable message so the model self-corrects in the same turn. The
   * cross-provider lock (§7.2.1) is snapshot-independent; catalog checks
   * degrade silently when no snapshot is available (§7.0).
   */
  private validateRouteForDispatch(route: ResolvedSubagentRoute): string | undefined {
    const snapshot = this.currentRoutingSnapshot();
    const crossProvider = !!route.providerId && route.providerId !== this.providerId;

    if (crossProvider) {
      // §7.2.1 — the lock. Profile/user-category routes are standing user
      // authorization and always pass; only call-site routes are lockable.
      if (!this.agentRouting.allowCrossProvider && route.modelSource === "callsite") {
        throw new Error(
          "Cross-provider routing is disabled in this session's config (agentRouting.allowCrossProvider). "
          + "Use a model from the parent provider, or ask the user to unlock cross-provider routing.",
        );
      }
      // §7.2.2 — credentials, when a snapshot is available.
      if (snapshot && !snapshot.runnableProviderIds.includes(route.providerId)) {
        throw new Error(
          `Provider "${route.providerId}" is not configured with active credentials. `
          + `Available: ${snapshot.runnableProviderIds.join(", ") || "(none)"}.`,
        );
      }
      // §7.2.3 amended (v3.6): the provider stays the authority — no hard
      // catalog rejection — but a near-match against the target provider's
      // local catalog is positive evidence of a mistyped id (a Grok parent
      // invented "openai:gpt-5.6" for gpt-5.6-sol), so soft-reject with the
      // correction and let the model fix it this turn. Genuinely unknown ids
      // (no near candidates) still pass through with a note.
      const targetCatalog = this.routableModelIndex?.()
        .filter((entry) => entry.providerId === route.providerId) ?? [];
      if (targetCatalog.length > 0 && !targetCatalog.some((entry) => entry.id === route.model)) {
        const near = nearModelMatches(route.model, targetCatalog, { mode: "truncation" });
        if (near.length > 0) {
          throw new Error(
            `Unknown model "${route.model}" for provider "${route.providerId}". Did you mean: ${near.join(", ")}?`,
          );
        }
        return `model ${route.providerId}:${route.model} is not in the local catalog; the provider validates it`;
      }
      return `model ${route.providerId}:${route.model} is not locally verifiable; the provider validates it`;
    }

    // §7.1 — same-provider unknown model, resolved-provider based (never
    // input-syntax based; qualified same-provider ids land here too).
    if (snapshot && route.modelSource === "callsite") {
      const known = snapshot.models.some((model) => model.id === route.model);
      if (!known) {
        if (snapshot.authoritative) {
          const available = snapshot.models
            .map((model) => (model.tier ? `${model.id} (${model.tier})` : model.id))
            .join(", ");
          throw new Error(
            `Unknown model "${route.model}" for provider "${this.providerId}". Available: ${available}.`,
          );
        }
        const near = nearModelMatches(
          route.model,
          snapshot.models.map((model): RoutableModelEntry => ({ providerId: this.providerId, id: model.id, name: model.name })),
        );
        return near.length > 0
          ? `model id "${route.model}" is unrecognized locally (did you mean: ${near.join(", ")}?); the provider validates it`
          : `model id "${route.model}" is unrecognized locally; the provider validates it`;
      }
    }
    return undefined;
  }

  /** Routable catalog across runnable providers (design v3.6); undefined when unwired. */
  listRoutableModels(): RoutableModelEntry[] | undefined {
    try {
      return this.routableModelIndex?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Decision-point detector (design §6): counts dispatches whose model was
   * decided by NO routing layer (modelSource "inherit") under a strong-tier
   * parent. Fires once per session at the Nth qualifying dispatch; the
   * reminder rides the same channel as the lifecycle reminder.
   */
  private noteRoutingDispatch(route: ResolvedSubagentRoute): void {
    if (this.routingReminderFired) return;
    if (route.modelSource !== "inherit") return;
    const snapshot = this.currentRoutingSnapshot();
    if (snapshot?.parent.tier !== "strong") return;
    this.defaultedRoutingStreak++;
    if (this.defaultedRoutingStreak >= ROUTING_REMINDER_THRESHOLD) {
      this.routingReminderFired = true;
      this.pendingRoutingReminder = [
        `Routing note: ${this.defaultedRoutingStreak} children in this fan-out defaulted to the parent's`,
        "strong-tier model (no model/category given). If any of these tasks are mechanical",
        "(scan / summarize / search / extract), route them with category \"quick\"/\"explore\" or a",
        "fast-tier model next time. If they genuinely need this model, ignore this note.",
      ].join(" ");
    }
  }

  /** Consumed by the turn hooks; also closes the counting window (§6). */
  consumePendingRoutingReminder(): string | undefined {
    const reminder = this.pendingRoutingReminder;
    this.pendingRoutingReminder = undefined;
    if (!this.routingReminderFired) this.defaultedRoutingStreak = 0;
    return reminder;
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
  }): SubagentThreadRecord {
    const now = Date.now();
    const nickname = options.nickname ?? assignAgentNickname(options.profile, this.activeSubagentNicknames());
    return {
      agentId: options.agentId ?? randomUUID(),
      runId: options.runId ?? randomUUID(),
      nickname,
      profile: options.profile,
      category: options.route?.category,
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
  ): Promise<NonNullable<SubagentThreadRecord["agent"]>> {
    let childCwd = cwd;
    let childMode: PermissionMode = "plan";
    if (record.profile.mode === "write_worktree") {
      // Write children work in a runtime-allocated worktree with fresh tool
      // instances bound to it (design §8): the parent tree is never touched,
      // and the tools' own workspace fence enforces containment in code.
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
      providerId: this.providerId,
      model: this.apiModel,
      thinkingLevel: this.thinkingLevel,
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
        ? this.memoryPrompt
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
    const subAgent = new Agent({
      provider,
      providerId: route.providerId,
      model: route.model,
      tools,
      temperature: this.temperature,
      thinkingLevel: route.thinkingLevel,
      mode: childMode,
      maxTurns: record.profile.maxTurns,
      budgetLedger: this.budgetLedger,
      budgetSource: { runId: record.runId, subAgentId: record.agentId },
      systemPrompt: childSystemPrompt,
      hooks: this.hookDefinitions,
      externalHooks: this.externalHooks,
      agentRole: "subagent",
      subAgentId: record.agentId,
      agentCategories: this.agentCategories,
      providerFactory: this.providerFactory,
      // The scheduler owns 429 backoff for children; the transport must not
      // stack its own retries on top (design §4.5).
      rateLimitPolicy: "defer",
    });
    if (record.messages && record.messages.length > 0) {
      // Cross-restart resume (design §7): rebuild the child from its
      // persisted history — including its original system prompt — so
      // send_input continues with context intact.
      subAgent.messages = record.messages.map((message) => ({ ...message }));
      record.messages = undefined;
    } else if (forkContext) {
      subAgent.messages = this.forkMessagesForSubagent(childSystemPrompt);
    }
    return subAgent;
  }

  private async resolveProviderForRoute(route: ResolvedSubagentRoute): Promise<Provider> {
    if (!route.providerId || route.providerId === this.providerId) {
      return this.provider;
    }
    if (!this.providerFactory) {
      throw new Error([
        `Subagent route requires provider "${route.providerId}" for model "${route.model}",`,
        `but the parent agent only has provider "${this.providerId || "none"}" and no provider factory is configured.`,
      ].join(" "));
    }
    return this.providerFactory(route);
  }

  private forkMessagesForSubagent(childSystemPrompt: string): Message[] {
    const forked = this.messages
      .filter((message) => {
        if (message.role === "system" || message.role === "meta") return false;
        if (message.role === "assistant" && message.toolCalls?.some((call) => isSubagentLifecycleTool(call.name))) {
          return false;
        }
        if (message.role === "tool" && message.metadata?.kind === "subagent") {
          return false;
        }
        return true;
      })
      .slice(-20);
    return [{ role: "system", content: childSystemPrompt }, ...forked];
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
        subagents: [{
          subAgentId: record.agentId,
          agentName: record.profile.name,
          nickname: record.nickname,
          category: record.category,
          route: record.route,
          status,
          profileSource: record.profile.source,
          task: record.task,
          summary: record.summary,
          toolNotes: record.toolNotes,
          usage: record.usage,
          error: record.error,
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
    this.pendingSubagentUpdates.push({
      id: record.parentToolCallId,
      name: record.parentToolName,
      update: this.buildSubagentUpdate(record, status, event, message),
    });
    this.wakeSubagentUpdateWaiters();
  }

  private drainSubagentToolUpdates(): AgentEvent[] {
    return this.pendingSubagentUpdates.splice(0, this.pendingSubagentUpdates.length)
      .map((pending) => ({
        type: "tool_update" as const,
        id: pending.id,
        name: pending.name,
        update: pending.update,
      }));
  }

  private activeSubagentNicknames(): string[] {
    return this.subagentStore.active().map((record) => record.nickname);
  }

  private resolveSubagentTargets(agentIds?: string[]): SubagentThreadRecord[] {
    if (!agentIds || agentIds.length === 0) {
      return this.subagentStore.values().filter((record) => record.status !== "closed" && !record.workflowInternal);
    }
    return agentIds.map((id) => {
      const record = this.subagentStore.get(id);
      if (!record) {
        throw new Error(`Unknown subagent: ${id}`);
      }
      return record;
    });
  }

  private maybeCompactResidentHistory(): void {
    if (this.messages.length === 0) {
      return;
    }

    const before = this.messages;
    const beforeChars = estimateResidentChars(before);
    const beforeToolChars = estimateToolPayloadChars(before);
    let candidate = projectMessages(before, { mode: "pruned" });

    const budget = this.providerId && this.apiModel
      ? getContextBudget(this.providerId, this.apiModel, candidate)
      : undefined;
    const heapUsed = getCurrentHeapUsed();
    const residentChars = estimateResidentChars(candidate);
    const keepRecentTurns = countUserTurns(candidate) > 10
      ? 2
      : RESIDENT_HISTORY_KEEP_RECENT_TURNS;
    const shouldAggressivelyPrune = residentChars >= RESIDENT_HISTORY_CHAR_HARD_LIMIT
      || heapUsed >= RESIDENT_HISTORY_HEAP_HARD_LIMIT;
    const shouldCompact = !!budget?.shouldCompact
      || candidate.length >= RESIDENT_HISTORY_MESSAGE_LIMIT
      || residentChars >= RESIDENT_HISTORY_CHAR_SOFT_LIMIT;

    if (shouldAggressivelyPrune) {
      candidate = aggressivePruneMessages(candidate);
    }

    if (shouldCompact) {
      const compacted = compactMessages(candidate, { keepRecentTurns });
      if (compacted.compacted && compacted.messages) {
        candidate = compacted.messages as typeof candidate;
      }
    }

    const afterChars = estimateResidentChars(candidate);
    const afterToolChars = estimateToolPayloadChars(candidate);
    if (
      afterChars < beforeChars
      || afterToolChars < beforeToolChars
      || candidate.length < before.length
    ) {
      this.messages = candidate;
      this.lastInputTokens = null;
      this.lastAnchorMessageCount = null;
      this.fileStateTracker?.invalidateReadHistory();
    }
  }

  private appendMessage(message: Message) {
    if (message.role === "assistant" && message.content) {
      message.content = sanitizeInternalReminderBlocks(message.content);
    }
    if (message.role === "assistant" && message.reasoning) {
      message.reasoning = sanitizeInternalReasoningText(message.reasoning);
    }
    if (message.role === "assistant" && message.providerMetadata) {
      message.providerMetadata = sanitizeAssistantProviderMetadata(message.providerMetadata);
    }
    this.messages.push(message);
    traceEvent("agent_message_append", {
      message: summarizeTraceMessage(message),
      messageCount: this.messages.length,
    }, {
      sessionFile: this.sessionID,
      provider: this._providerId || "none",
      model: this.apiModel || "none",
    });
    this.onMessageAppend?.(message);
  }

  private appendInterruptedAssistantBoundary(
    currentAssistant: Extract<Message, { role: "assistant" }> | undefined,
    currentAssistantAppended: boolean,
  ): boolean {
    const last = lastProviderMessage(this.messages);
    if (last?.role === "assistant" && last.error?.aborted) {
      return false;
    }

    const partialText = !currentAssistantAppended ? currentAssistant?.content.trim() : "";
    const content = partialText
      ? `${partialText}\n\n${INTERRUPTED_ASSISTANT_CONTENT}`
      : INTERRUPTED_ASSISTANT_CONTENT;

    this.appendMessage({
      role: "assistant",
      content,
      reasoning: !currentAssistantAppended ? currentAssistant?.reasoning : undefined,
      error: {
        name: "MessageAbortedError",
        message: "Assistant response was interrupted by the user.",
        aborted: true,
      },
    });
    return true;
  }

  private clearTodosAfterInterruptedRun(): boolean {
    if (this._todos.length === 0) return false;
    this.setTodos([]);
    return true;
  }

  private async executeTool(
    toolCall: ParsedToolCall,
    cwd: string,
    abortSignal?: AbortSignal,
    emitUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult> {
    throwIfAborted(abortSignal);
    if (toolCall.name === "exit_plan_mode" && this._mode !== "plan") {
      return {
        content:
          "Ignored exit_plan_mode because plan mode is not active. " +
          "Continue with the user's request directly using the regular tools.",
      };
    }

    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        content: `Error: Unknown tool "${toolCall.name}"`,
        isError: true,
      };
    }

    if (this._mode === "plan" && !tool.readOnly) {
      return {
        content:
          `Error: Tool "${toolCall.name}" is not allowed in plan mode. ` +
          `In plan mode you may only use read-only tools (read, glob, grep, web_search, web_fetch, spawn_agent, wait_agent, send_input, skill_search, skill, todo_write, tool_search, question, exit_plan_mode). ` +
          `To modify files or run commands, present your proposal and call exit_plan_mode so the user can review and approve it.`,
        isError: true,
      };
    }

    if (tool.deferred && !this.unlockedDeferred.has(tool.name)) {
      return {
        content:
          `Error: Tool "${toolCall.name}" is a deferred tool; its schema is not yet loaded. ` +
          `Call tool_search first with query "select:${toolCall.name}" to load its schema, then retry.`,
        isError: true,
      };
    }

    if (toolCall.argsCorrupt) {
      return {
        content:
          `Error: The arguments for "${toolCall.name}" failed to parse as JSON, indicating the provider returned truncated or malformed tool arguments. ` +
          `Re-issue the call with valid JSON arguments; do not assume the previous attempt ran.`,
        isError: true,
        status: "blocked",
        metadata: { kind: "security", reason: "args_corrupt" },
      };
    }

    let preparedArgs = toolCall.parsedArgs;
    if (tool.prepareArguments) {
      try {
        preparedArgs = tool.prepareArguments(preparedArgs);
      } catch (err) {
        return {
          content:
            `Error: Tool "${toolCall.name}" arguments could not be normalized before execution: ` +
            `${err instanceof Error ? err.message : String(err)}. Re-issue the call with valid arguments.`,
          isError: true,
          status: "blocked",
          metadata: { kind: "security", reason: "args_prepare_failed" },
        };
      }
    }

    const missingRequired = findMissingRequiredArgs(tool.parameters, preparedArgs);
    if (missingRequired.length > 0) {
      return {
        content:
          `Error: Tool "${toolCall.name}" was called without required argument${missingRequired.length === 1 ? "" : "s"}: ${missingRequired.map((name) => `"${name}"`).join(", ")}. ` +
          `Re-issue the call with all required fields filled. Do not assume the previous attempt ran with default values.`,
        isError: true,
        status: "blocked",
        metadata: { kind: "security", reason: "missing_required_args", missing: missingRequired },
      };
    }

    try {
      return await tool.execute(preparedArgs, {
        cwd,
        sessionID: this.sessionID,
        abortSignal,
        toolCall: { id: toolCall.id, name: toolCall.name },
        agent: this,
        emitUpdate,
      });
    } catch (err: any) {
      return {
        content: `Error executing ${toolCall.name}: ${err.message || String(err)}`,
        isError: true,
      };
    }
  }
}

function findMissingRequiredArgs(
  schema: { required?: string[] } | undefined,
  args: Record<string, any> | undefined,
): string[] {
  const required = schema?.required;
  if (!required || required.length === 0) return [];
  const missing: string[] = [];
  for (const name of required) {
    const value = args ? args[name] : undefined;
    // Empty strings/arrays are intentionally allowed — writing an empty file
    // or passing an empty list can be legitimate. Only undefined/null counts
    // as "missing", because the observed failure mode is `finalArgs: "{}"`
    // where the field is entirely absent.
    if (value === undefined || value === null) {
      missing.push(name);
    }
  }
  return missing;
}

function estimateResidentChars(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "meta":
        total += message.content.length;
        break;
      case "tool":
        total += message.content.length + message.toolCallId.length;
        break;
      case "assistant":
        total += message.content.length + (message.reasoning?.length ?? 0);
        total += message.toolCalls?.reduce(
          (sum, toolCall) => sum + toolCall.id.length + toolCall.name.length + toolCall.arguments.length,
          0,
        ) ?? 0;
        break;
      case "user":
        if (typeof message.content === "string") {
          total += message.content.length;
        } else {
          total += message.content.reduce((sum, part) => {
            if (part.type === "text") {
              return sum + part.text.length;
            }
            return sum + part.image_url.url.length;
          }, 0);
        }
        break;
    }
  }

  return total;
}

function appendProviderContentBlock(
  message: Extract<Message, { role: "assistant" }>,
  provider: ProviderMetadataProvider,
  block: ProviderRawContentBlock,
): void {
  const current = message.providerMetadata?.[provider]?.contentBlocks ?? [];
  message.providerMetadata = {
    ...message.providerMetadata,
    [provider]: {
      ...message.providerMetadata?.[provider],
      contentBlocks: [...current, cloneProviderRawContentBlock(block)],
    },
  };
}

function buildProviderRequestFingerprint(
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  providerId: string,
  toolChoice?: string,
): Record<string, unknown> {
  const roleCounts: Record<string, number> = {};
  let contentChars = 0;
  let reasoningChars = 0;
  let toolResultChars = 0;
  let maxToolResultChars = 0;
  let assistantToolCalls = 0;
  let rawAnthropicBlocks = 0;
  let rawAnthropicThinkingBlocks = 0;
  let rawAnthropicSignatureChars = 0;

  for (const message of messages) {
    roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1;
    if (message.role === "assistant") {
      contentChars += message.content.length;
      reasoningChars += message.reasoning?.length ?? 0;
      assistantToolCalls += message.toolCalls?.length ?? 0;
      const blocks = message.providerMetadata?.anthropic?.contentBlocks ?? [];
      rawAnthropicBlocks += blocks.length;
      for (const block of blocks) {
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          rawAnthropicThinkingBlocks += 1;
        }
        if (typeof block.signature === "string") {
          rawAnthropicSignatureChars += block.signature.length;
        }
      }
    } else if (message.role === "tool") {
      toolResultChars += message.content.length;
      maxToolResultChars = Math.max(maxToolResultChars, message.content.length);
    } else if (message.role === "user") {
      contentChars += typeof message.content === "string"
        ? message.content.length
        : message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : part.image_url.url.length), 0);
    } else {
      contentChars += message.content.length;
    }
  }

  const systemMessages = messages.filter((message) => message.role === "system");
  const bodyMessages = messages.filter((message) => message.role !== "system");
  const systemJsonBytes = Buffer.byteLength(JSON.stringify(systemMessages), "utf8");
  const bodyJsonBytes = Buffer.byteLength(JSON.stringify(bodyMessages), "utf8");
  const toolSchemaJsonBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");

  return {
    roleCounts,
    estimatedTokens: estimateContextTokens(messages as Message[], providerId),
    projectedJsonBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
    systemJsonBytes,
    bodyJsonBytes,
    toolSchemaJsonBytes,
    staticPrefixJsonBytes: Buffer.byteLength(JSON.stringify({
      system: systemMessages,
      tools,
      tool_choice: toolChoice,
    }), "utf8"),
    toolChoice,
    contentChars,
    reasoningChars,
    toolResultChars,
    maxToolResultChars,
    assistantToolCalls,
    rawAnthropicBlocks,
    rawAnthropicThinkingBlocks,
    rawAnthropicSignatureChars,
  };
}

function cloneProviderRawContentBlock(block: ProviderRawContentBlock): ProviderRawContentBlock {
  return JSON.parse(JSON.stringify(block)) as ProviderRawContentBlock;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new AgentAbortError(typeof reason === "string" ? reason : undefined);
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof AgentAbortError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") return true;
  return false;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return isAbortLikeError(error, signal);
}

function shouldAppendModelInterruptedBoundary(messages: Message[]): boolean {
  return messages.at(-1)?.role === "tool";
}

function createModelInterruptedMessage(
  error: unknown,
  metadata: { model: string; providerId: string; modelId: string },
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    content: `[model request interrupted before a final answer was produced: ${summarizeInterruptError(error)}]`,
    model: metadata.model,
    providerId: metadata.providerId,
    modelId: metadata.modelId,
  };
}

function summarizeInterruptError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

function lastProviderMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "system" || message.role === "meta") continue;
    return message;
  }
  return undefined;
}

function cancelledToolResult(toolName: string): ToolResult {
  return {
    content: `Tool "${toolName}" was cancelled.`,
    isError: true,
    status: "cancelled",
    metadata: { reason: "cancelled" },
  };
}

function createUpdateQueue<T>() {
  const items: T[] = [];
  let waiter: ((status: "woken" | "aborted") => void) | undefined;
  let abortCleanup: (() => void) | undefined;
  return {
    push(item: T) {
      items.push(item);
      this.wake();
    },
    drain(): T[] {
      return items.splice(0, items.length);
    },
    hasItems(): boolean {
      return items.length > 0;
    },
    wait(signal?: AbortSignal): Promise<"woken" | "aborted"> {
      if (items.length > 0) return Promise.resolve("woken");
      if (signal?.aborted) return Promise.resolve("aborted");
      return new Promise((resolve) => {
        abortCleanup?.();
        abortCleanup = undefined;
        const finish = (status: "woken" | "aborted") => {
          if (waiter !== resolve) return;
          waiter = undefined;
          abortCleanup?.();
          abortCleanup = undefined;
          resolve(status);
        };
        if (signal) {
          const onAbort = () => finish("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => signal.removeEventListener("abort", onAbort);
        }
        waiter = resolve;
      });
    },
    wake() {
      const resolve = waiter;
      waiter = undefined;
      abortCleanup?.();
      abortCleanup = undefined;
      resolve?.("woken");
    },
  };
}

function estimateToolPayloadChars(messages: Message[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== "tool") {
      return sum;
    }
    return sum + message.content.length;
  }, 0);
}

function countUserTurns(messages: Message[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}

function getCurrentHeapUsed(): number {
  try {
    return process.memoryUsage().heapUsed;
  } catch {
    return 0;
  }
}

function isFinalSubagentStatus(status: SubagentThreadRecord["status"]): boolean {
  return status === "completed"
    || status === "failed"
    || status === "blocked"
    || status === "cancelled"
    || status === "closed";
}

/**
 * Persists the full rendered workflow result so the inline preview can stay
 * bounded without losing data (the parent reads the file selectively when the
 * preview was cut). A write failure only costs the pointer, never the run.
 */
function persistWorkflowResult(runId: string, value: unknown): string | undefined {
  try {
    const dir = join(getBubbleHome(), "workflows");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${runId}.result.txt`);
    writeFileSync(path, renderWorkflowResultValue(value));
    return path;
  } catch {
    return undefined;
  }
}

function normalizeWaitTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30_000;
  return Math.max(100, Math.min(3_600_000, Math.floor(value)));
}

function isSubagentLifecycleTool(name: string): boolean {
  return name === "subagent"
    || name === "spawn_agent"
    || name === "wait_agent"
    || name === "send_input"
    || name === "close_agent"
    || name === "list_agents"
    || name === "run_workflow"
    || name === "wait_workflow"
    // Legacy names: still present in transcripts recorded before the tools
    // were removed (2026-07-06); forked children must not inherit their
    // dangling tool_calls either.
    || name === "agent_team"
    || name === "agent_batch";
}






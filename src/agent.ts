/**
 * Agent - The core decision loop.
 * It maintains message state, calls the LLM, executes tools, and auto-continues.
 */

import { compactMessages } from "./context/compact.js";
import { randomUUID } from "node:crypto";
import { compactMessagesWithLLM } from "./context/compact-llm.js";
import { estimateContextTokens, getContextBudget } from "./context/budget.js";
import { buildContextUsageSnapshot, type ContextUsageSnapshot } from "./context/usage.js";
import { isContextOverflowError } from "./context/overflow.js";
import { projectMessages } from "./context/projector.js";
import { aggressivePruneMessages, markStableCurrentToolResultsForCache } from "./context/prune.js";
import { truncateToolOutputForModel } from "./context/tool-output-truncate.js";
import { buildDeferredToolsReminder, buildToolFreezeReminder, reminderForMode } from "./prompt/reminders.js";
import type { AgentEvent, AgentInputController, AgentRunInput, ContentPart, PermissionMode, Message, ParsedToolCall, Provider, ProviderMessage, ProviderRawContentBlock, ThinkingLevel, Todo, TokenUsage, ToolDefinition, ToolResult, ToolRegistryEntry, ToolUpdate } from "./types.js";
import { HookBus, type TurnHooks, type TurnHookState } from "./orchestrator/hooks.js";
import { createDefaultHooks } from "./orchestrator/default-hooks.js";
import { resolveModelRoute, resolveSubagentRoute, type AgentCategoriesConfig, type ResolvedSubagentRoute } from "./agent/categories.js";
import { getSubtaskPolicy, type SubtaskType } from "./agent/subtask-policy.js";
import { BudgetLedger, composeAbortSignals } from "./agent/budget-ledger.js";
import { assignAgentNickname, builtinAgentProfiles, mergeUsage, selectToolsForAgentProfile, validateAgentProfileTools, type AgentProfile, type SubagentRunResult } from "./agent/profiles.js";
import { snapshotSubagentThread, subagentResultFromThread, type PendingSubagentToolUpdate, type SubagentThreadRecord, type SubagentThreadSnapshot } from "./agent/subagent-control.js";
import { isHiddenToolResult } from "./agent/discovery-barrier.js";
import { createStreamingInternalReminderSanitizer, sanitizeAssistantProviderMetadata, sanitizeInternalReminderBlocks } from "./agent/internal-reminder-sanitizer.js";
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
const EMPTY_ASSISTANT_FALLBACK =
  "The model returned no user-visible response. Please retry, or switch models if this keeps happening.";
const INTERRUPTED_ASSISTANT_CONTENT =
  "Interrupted by user. The prior request was stopped and should not be resumed unless the user asks.";

export class AgentAbortError extends Error {
  constructor(message = "Agent run cancelled.") {
    super(message);
    this.name = "AgentAbortError";
  }
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
  budgetLedger?: BudgetLedger;
  budgetSource?: { runId: string; subAgentId?: string };
  skills?: SkillSummary[];
  memoryPrompt?: string;
  fileStateTracker?: FileStateTracker;
  agentCategories?: AgentCategoriesConfig;
  providerFactory?: (route: ResolvedSubagentRoute) => Provider | Promise<Provider>;
}

export interface AgentRunOptions {
  abortSignal?: AbortSignal;
  inputController?: AgentInputController;
}

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
  private maxTurns?: number;
  private taskBudget?: { total: number };
  private budgetLedger?: BudgetLedger;
  private budgetSource: { runId: string; subAgentId?: string };
  private skillSummaries: SkillSummary[];
  private memoryPrompt?: string;
  private fileStateTracker?: FileStateTracker;
  private agentCategories: AgentCategoriesConfig;
  private providerFactory?: (route: ResolvedSubagentRoute) => Provider | Promise<Provider>;
  private subagentThreads: Map<string, SubagentThreadRecord> = new Map();
  private pendingSubagentUpdates: PendingSubagentToolUpdate[] = [];
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
    this.maxTurns = options.maxTurns ?? options.steps;
    this.taskBudget = options.taskBudget;
    this.budgetLedger = options.budgetLedger;
    this.budgetSource = options.budgetSource ?? { runId: this.sessionID ?? "agent" };
    this.skillSummaries = options.skills ?? [];
    this.memoryPrompt = options.memoryPrompt;
    this.fileStateTracker = options.fileStateTracker;
    this.agentCategories = options.agentCategories ?? {};
    this.providerFactory = options.providerFactory;

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
    const deferredNames = [...this.tools.values()]
      .filter((t) => t.deferred)
      .map((t) => t.name);
    if (deferredNames.length > 0) {
      this.injectSystemReminder(buildDeferredToolsReminder(deferredNames));
    }
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

  getSystemPromptToolOptions(): Pick<import("./system-prompt.js").SystemPromptOptions, "tools" | "toolSnippets" | "guidelines"> {
    return buildToolPromptOptions(this.getActiveToolEntries());
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
    const abortSignal = composeAbortSignals([options.abortSignal, this.budgetLedger?.signal]);
    const inputController = options.inputController;
    const traceContext = {
      cwd,
      sessionFile: this.sessionID,
      provider: this._providerId || "none",
      model: this.apiModel || "none",
    };
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
    const applyPendingInputs = (): AgentEvent[] => {
      const pendingInputs = inputController?.drainPendingInputs() ?? [];
      if (pendingInputs.length === 0) return [];
      for (const input of pendingInputs) {
        this.appendMessage({ role: "user", content: input.content });
      }
      return [
        ...pendingInputs.map((input): AgentEvent => ({
          type: "input_applied",
          id: input.id,
          content: input.content,
          target: "current_turn",
        })),
        { type: "input_pending_changed", pending: pendingInputCount() },
      ];
    };
    const rejectPendingInputs = (reason: "no_continuation"): AgentEvent[] => {
      const pendingInputs: AgentRunInput[] = inputController?.drainPendingInputs() ?? [];
      if (pendingInputs.length === 0) return [];
      return [
        ...pendingInputs.map((input): AgentEvent => ({
          type: "input_rejected",
          id: input.id,
          content: input.content,
          reason,
          target: "next_turn",
        })),
        { type: "input_pending_changed", pending: pendingInputCount() },
      ];
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
    this.appendMessage({ role: "user", content: userInput });
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
      for (const update of this.drainSubagentToolUpdates()) yield emit(update);
      for (const event of applyPendingInputs()) yield emit(event);
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

            while (!settled || updateQueue.hasItems()) {
              for (const update of updateQueue.drain()) {
                yield emit({ type: "tool_update", id: tc.id, name: tc.name, update });
              }
              for (const update of this.drainSubagentToolUpdates()) yield emit(update);
              if (!settled) {
                const waitStatus = await updateQueue.wait(abortSignal);
                if (waitStatus === "aborted" && !settled) {
                  cancelledByAbort = true;
                  break;
                }
              }
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
      const willContinue = !!(hookState as any).forceContinuationReason;
      yield emit({ type: "turn_end", usage: turnUsage, willContinue });
      if (willContinue) {
        delete (hookState as any).forceContinuationReason;
        continue;
      }
      for (const event of rejectPendingInputs("no_continuation")) yield emit(event);
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

  async runSubtask(
    input: string | ContentPart[],
    cwd: string,
    options?: { subtaskType?: string; description?: string },
  ): Promise<ToolResult> {
    const subtaskType = options?.subtaskType as SubtaskType | undefined;
    const profile = builtinAgentProfiles().find((item) => item.subtaskType === (subtaskType ?? "general_readonly"))
      ?? builtinAgentProfiles().find((item) => item.subtaskType === "general_readonly")!;
    const run = await this.runSubAgent(input, cwd, {
      profile,
      runId: randomUUID(),
      subAgentId: randomUUID(),
      parentToolCallId: "task",
      route: this.resolveRouteForSubagent(profile, undefined),
      description: options?.description,
    });
    const lines = [
      "Note: task is deprecated. Use spawn_agent with a named profile instead.",
      `Subtask type: ${profile.subtaskType ?? "general_readonly"}`,
    ];
    if (options?.description) {
      lines.push(`Subtask description: ${options.description}`);
    }
    if (run.summary) {
      lines.push("", "Subtask summary:", run.summary);
    }
    if (run.toolNotes.length > 0) {
      lines.push("", "Subtask tools:", ...run.toolNotes.slice(0, 8).map((note) => `- ${note}`));
    }
    return {
      content: lines.join("\n"),
      status: getSubtaskPolicy(subtaskType).resultStatus,
      isError: run.status !== "completed",
      metadata: {
        kind: "subagent",
        reason: `Subtask (${profile.subtaskType ?? "general_readonly"}) investigation completed.`,
        subagents: [run],
      },
    };
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
    await this.runSubagentThread(record, input, cwd, {
      approval: options.approval ?? options.profile.approval,
      abortSignal: options.abortSignal,
      forkContext: options.forkContext,
      directEmit: options.emitUpdate,
    });
    return subagentResultFromThread(record);
  }

  async spawnSubAgent(
    input: string | ContentPart[],
    cwd: string,
    options: {
      profile: AgentProfile;
      parentToolCallId: string;
      category?: string;
      route?: ResolvedSubagentRoute;
      approval?: "fail" | "disabled";
      description?: string;
      abortSignal?: AbortSignal;
      forkContext?: boolean;
    },
  ): Promise<SubagentThreadSnapshot> {
    const record = this.createSubagentThreadRecord({
      profile: options.profile,
      task: typeof input === "string" ? input : "(multimodal task)",
      parentToolCallId: options.parentToolCallId,
      parentToolName: "spawn_agent",
      route: options.route ?? this.resolveRouteForSubagent(options.profile, options.category),
    });
    this.subagentThreads.set(record.agentId, record);
    this.queueSubagentUpdate(record, "queued", undefined, `Queued ${record.nickname} (${record.profile.name})`);
    record.promise = this.runSubagentThread(record, input, cwd, {
      approval: options.approval ?? record.profile.approval,
      abortSignal: options.abortSignal,
      forkContext: options.forkContext,
      queueUpdates: true,
    });
    void record.promise.finally(() => this.notifySubagentWaiters(record));
    return snapshotSubagentThread(record);
  }

  async waitSubAgents(options: { agentIds?: string[]; timeoutMs?: number } = {}): Promise<SubagentThreadSnapshot[]> {
    const targets = this.resolveSubagentTargets(options.agentIds);
    if (targets.length === 0) return [];
    const completed = targets.filter((record) => isFinalSubagentStatus(record.status));
    if (completed.length > 0) return completed.map(snapshotSubagentThread);

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
    return (finished.length > 0 ? finished : targets).map(snapshotSubagentThread);
  }

  async sendSubAgentInput(
    agentId: string,
    input: string | ContentPart[],
    cwd: string,
    options: { interrupt?: boolean; parentToolCallId?: string; abortSignal?: AbortSignal } = {},
  ): Promise<SubagentThreadSnapshot> {
    const record = this.subagentThreads.get(agentId);
    if (!record) {
      throw new Error(`Unknown subagent: ${agentId}`);
    }
    if (record.status === "running" || record.status === "queued") {
      if (!options.interrupt) {
        throw new Error(`Subagent ${agentId} is still running. Call wait_agent first or pass interrupt:true.`);
      }
      record.abortController.abort(new AgentAbortError(`Subagent ${agentId} interrupted.`));
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
    record.updatedAt = Date.now();
    record.promise = this.runSubagentThread(record, input, cwd, {
      approval: record.profile.approval,
      abortSignal: options.abortSignal,
      queueUpdates: true,
      reuseAgent: true,
    });
    void record.promise.finally(() => this.notifySubagentWaiters(record));
    return snapshotSubagentThread(record);
  }

  async closeSubAgent(agentId: string): Promise<SubagentThreadSnapshot> {
    const record = this.subagentThreads.get(agentId);
    if (!record) {
      throw new Error(`Unknown subagent: ${agentId}`);
    }
    if (!isFinalSubagentStatus(record.status)) {
      record.abortController.abort(new AgentAbortError(`Subagent ${agentId} closed.`));
      await record.promise?.catch(() => undefined);
    }
    record.status = "closed";
    record.updatedAt = Date.now();
    this.queueSubagentUpdate(record, "cancelled", undefined, `${record.nickname} closed`);
    this.notifySubagentWaiters(record);
    return snapshotSubagentThread(record);
  }

  listSubAgents(): SubagentThreadSnapshot[] {
    return [...this.subagentThreads.values()].map(snapshotSubagentThread);
  }

  private resolveRouteForSubagent(profile: AgentProfile, category: string | undefined): ResolvedSubagentRoute {
    const parentRoute = {
      providerId: this.providerId,
      model: this.apiModel,
      thinkingLevel: this.thinkingLevel,
    };
    const resolved = resolveSubagentRoute(category ?? profile.category, {
      ...parentRoute,
    }, this.agentCategories);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    if (profile.model && profile.model !== "inherit") {
      const model = resolveModelRoute(profile.model, parentRoute.providerId);
      if (model.model !== "inherit") {
        return {
          ...resolved.route,
          providerId: model.providerId,
          model: model.model,
          inherited: false,
        };
      }
    }
    return resolved.route;
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

  private async runSubagentThread(
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
    const emit = (status: ToolUpdate["status"], event?: AgentEvent, message?: string) => {
      const update = this.buildSubagentUpdate(record, status, event, message);
      options.directEmit?.(update);
      if (options.queueUpdates) {
        this.pendingSubagentUpdates.push({ id: record.parentToolCallId, name: record.parentToolName, update });
      }
    };

    const allTools = [...this.tools.values()];
    const diagnostics = validateAgentProfileTools(allTools, record.profile, options.approval);
    const blockingDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    for (const diagnostic of diagnostics.filter((item) => item.severity === "warning")) {
      record.toolNotes.push(`profile: ${diagnostic.message}`);
    }
    if (blockingDiagnostics.length > 0) {
      record.status = "blocked";
      record.error = blockingDiagnostics.map((diagnostic) => diagnostic.message).join("\n");
      record.updatedAt = Date.now();
      emit("blocked", undefined, record.error);
      this.notifySubagentWaiters(record);
      return;
    }

    const tools = selectToolsForAgentProfile(allTools, record.profile, options.approval);
    let subAgent: NonNullable<SubagentThreadRecord["agent"]>;
    try {
      subAgent = options.reuseAgent && record.agent
        ? record.agent
        : await this.createSubAgentInstance(record, tools, cwd, options.forkContext);
    } catch (error: any) {
      record.status = "blocked";
      record.error = error?.message || String(error);
      record.updatedAt = Date.now();
      emit("blocked", undefined, record.error);
      this.notifySubagentWaiters(record);
      return;
    }
    record.agent = subAgent;
    record.status = "running";
    record.updatedAt = Date.now();
    emit("running", undefined, `Running ${record.nickname} (${record.profile.name})...`);
    let turnSummaryBuffer = "";
    let turnHadToolCall = false;
    let executedAnyTool = false;

    try {
      const childAbortSignal = composeAbortSignals([
        options.abortSignal,
        record.abortController.signal,
      ]);
      for await (const event of subAgent.run(input, cwd, { abortSignal: childAbortSignal })) {
        if (event.type === "text_delta") {
          turnSummaryBuffer += event.content;
        }
        if (
          event.type === "tool_call_start"
          || event.type === "tool_call_delta"
          || event.type === "tool_call_end"
          || event.type === "tool_start"
        ) {
          turnHadToolCall = true;
        }
        if (event.type === "tool_end") {
          executedAnyTool = true;
          record.toolNotes.push(`${event.name}: ${summarizeSubagentToolEnd(event)}`);
        }
        if (event.type === "turn_end" && event.usage) {
          record.usage = mergeUsage(record.usage, event.usage);
        }
        if (event.type === "turn_end") {
          const turnSummary = stripProviderProtocolArtifacts(turnSummaryBuffer).trim();
          if (!turnHadToolCall && turnSummary) {
            // Only the latest tool-free assistant turn is a candidate for the summary;
            // earlier ones are intermediate "I'll do X next" reasoning, not the final answer.
            record.summary = turnSummary;
          }
          turnSummaryBuffer = "";
          turnHadToolCall = false;
        }
        record.updatedAt = Date.now();
        emit("running", event);
      }
    } catch (error: any) {
      const cancelled = error instanceof AgentAbortError || error?.name === "AbortError";
      record.status = cancelled ? "cancelled" : "failed";
      record.summary = sanitizeSubagentSummary(record.summary);
      record.error = error?.message || String(error);
      record.updatedAt = Date.now();
      emit(record.status, undefined, record.error);
      this.notifySubagentWaiters(record);
      return;
    }

    record.summary = sanitizeSubagentSummary(record.summary);
    if (needsExplicitFinalSummary(record, executedAnyTool)) {
      await this.runSubagentFinalSummaryTurn(record, subAgent, cwd, options.abortSignal, emit);
    }

    record.status = "completed";
    record.summary = sanitizeSubagentSummary(record.summary);
    record.updatedAt = Date.now();
    emit("completed", undefined, record.summary || `${record.nickname} completed`);
    this.notifySubagentWaiters(record);
  }

  private async runSubagentFinalSummaryTurn(
    record: SubagentThreadRecord,
    subAgent: NonNullable<SubagentThreadRecord["agent"]>,
    cwd: string,
    abortSignal: AbortSignal | undefined,
    emit: (status: ToolUpdate["status"], event?: AgentEvent, message?: string) => void,
  ): Promise<void> {
    const prompt = [
      "Produce the final subagent summary now.",
      "Do not call tools. Do not announce next steps or plans.",
      "Use the evidence already gathered in this child thread.",
      "Return concise findings with concrete file paths and explicit uncertainty.",
      "Your entire response will be returned to the parent as the subagent's answer.",
    ].join("\n");
    subAgent.injectSystemReminder([
      "Subagent final-summary mode is active.",
      "Do not call tools. Do not announce next steps.",
      "Use only the evidence already gathered in this child thread.",
      "Return the final concise summary as your complete response.",
    ].join("\n"));
    let finalBuffer = "";
    let finalHadToolCall = false;
    const finalAbortSignal = composeAbortSignals([abortSignal, record.abortController.signal]);

    for await (const event of subAgent.run(prompt, cwd, { abortSignal: finalAbortSignal })) {
      if (event.type === "text_delta") {
        finalBuffer += event.content;
      }
      if (
        event.type === "tool_call_start"
        || event.type === "tool_call_delta"
        || event.type === "tool_call_end"
        || event.type === "tool_start"
      ) {
        finalHadToolCall = true;
      }
      if (event.type === "turn_end" && event.usage) {
        record.usage = mergeUsage(record.usage, event.usage);
      }
      emit("running", event);
    }

    const finalSummary = sanitizeSubagentSummary(finalBuffer);
    if (!finalHadToolCall && finalSummary) {
      record.summary = finalSummary;
    }
  }

  private async createSubAgentInstance(
    record: SubagentThreadRecord,
    tools: ToolRegistryEntry[],
    cwd: string,
    forkContext?: boolean,
  ): Promise<NonNullable<SubagentThreadRecord["agent"]>> {
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
      mode: "plan",
      workingDir: cwd,
      ...buildToolPromptOptions(tools),
      memoryPrompt: childToolNames.some((name) => name === "memory_search" || name === "memory_read_summary")
        ? this.memoryPrompt
        : undefined,
      agentProfilePrompt: [
        `You are subagent ${record.nickname}. Your agent profile is ${record.profile.name}.`,
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
      mode: "plan",
      maxTurns: record.profile.maxTurns,
      budgetLedger: this.budgetLedger,
      budgetSource: { runId: record.runId, subAgentId: record.agentId },
      systemPrompt: childSystemPrompt,
      hooks: this.hookDefinitions,
      agentCategories: this.agentCategories,
      providerFactory: this.providerFactory,
    });
    if (forkContext) {
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
    return [...this.subagentThreads.values()]
      .filter((record) => !isFinalSubagentStatus(record.status))
      .map((record) => record.nickname);
  }

  private resolveSubagentTargets(agentIds?: string[]): SubagentThreadRecord[] {
    if (!agentIds || agentIds.length === 0) {
      return [...this.subagentThreads.values()].filter((record) => record.status !== "closed");
    }
    return agentIds.map((id) => {
      const record = this.subagentThreads.get(id);
      if (!record) {
        throw new Error(`Unknown subagent: ${id}`);
      }
      return record;
    });
  }

  private notifySubagentWaiters(record: SubagentThreadRecord): void {
    for (const waiter of record.waiters) {
      waiter();
    }
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
      message.reasoning = sanitizeInternalReminderBlocks(message.reasoning);
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
          `In plan mode you may only use read-only tools (read, glob, grep, lsp, web_search, web_fetch, spawn_agent, wait_agent, send_input, close_agent, skill_search, skill, todo_write, tool_search, question, exit_plan_mode). ` +
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
          `Error: The arguments for "${toolCall.name}" failed to parse as JSON, indicating the tool call was truncated or malformed mid-stream. ` +
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
  provider: "anthropic",
  block: ProviderRawContentBlock,
): void {
  if (provider !== "anthropic") return;
  const current = message.providerMetadata?.anthropic?.contentBlocks ?? [];
  message.providerMetadata = {
    ...message.providerMetadata,
    anthropic: {
      ...message.providerMetadata?.anthropic,
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

function normalizeWaitTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30_000;
  return Math.max(100, Math.min(3_600_000, Math.floor(value)));
}

function isSubagentLifecycleTool(name: string): boolean {
  return name === "subagent"
    || name === "spawn_agent"
    || name === "wait_agent"
    || name === "send_input"
    || name === "close_agent";
}

function sanitizeSubagentSummary(value: string): string {
  return stripProviderProtocolArtifacts(value).trim();
}

function needsExplicitFinalSummary(record: SubagentThreadRecord, executedAnyTool: boolean): boolean {
  if (!record.summary) return executedAnyTool;
  if (isOnlyProviderProtocolArtifacts(record.summary)) return true;
  if (/<\/?[｜|][^<>]*>/.test(record.summary)) return true;
  if (!executedAnyTool) return false;
  if (record.summary === EMPTY_ASSISTANT_FALLBACK) return true;
  return isLikelyIntermediateSubagentSummary(record.summary);
}

function isLikelyIntermediateSubagentSummary(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return false;
  if (/^(let me|i'll|i will|i need to|i should|i'm going to|now i'll|now i will)\b/.test(normalized)) {
    return true;
  }
  return /:\s*$/.test(normalized) && /\b(read|inspect|check|look|search|try|open)\b/.test(normalized);
}

function summarizeSubagentToolEnd(event: { name: string; result: ToolResult }): string {
  const metadata = (event.result.metadata ?? {}) as Record<string, unknown>;
  const reason = readString(metadata.reason);
  if (reason) return reason;
  const summary = readString(metadata.summary);
  if (summary) return summary;
  if (event.result.isError) {
    const firstLine = event.result.content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return firstLine ? truncateForNote(firstLine) : "failed";
  }
  const matches = readNumber(metadata.matches);
  const pattern = readString(metadata.pattern);
  const path = readString(metadata.path);
  if (matches !== undefined) {
    const target = pattern ? ` for ${pattern}` : "";
    const within = path ? ` in ${path}` : "";
    return `${matches} match${matches === 1 ? "" : "es"}${target}${within}`;
  }
  const kind = readString(metadata.kind);
  if (path) return kind ? `${kind} ${path}` : path;
  return event.result.status ?? "completed";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateForNote(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

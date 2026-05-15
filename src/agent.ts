/**
 * Agent - The core decision loop.
 * It maintains message state, calls the LLM, executes tools, and auto-continues.
 */

import { compactMessages } from "./context/compact.js";
import { randomUUID } from "node:crypto";
import { compactMessagesWithLLM } from "./context/compact-llm.js";
import { getContextBudget } from "./context/budget.js";
import { isContextOverflowError } from "./context/overflow.js";
import { projectMessages } from "./context/projector.js";
import { aggressivePruneMessages } from "./context/prune.js";
import { buildDeferredToolsReminder, buildToolFreezeReminder, isPermissionModeReminder, reminderForMode } from "./prompt/reminders.js";
import type { AgentEvent, ContentPart, PermissionMode, Message, ParsedToolCall, Provider, ThinkingLevel, Todo, TokenUsage, ToolDefinition, ToolResult, ToolRegistryEntry, ToolUpdate } from "./types.js";
import { HookBus, type TurnHooks } from "./orchestrator/hooks.js";
import { createDefaultHooks } from "./orchestrator/default-hooks.js";
import { getSubtaskPolicy, type SubtaskType } from "./agent/subtask-policy.js";
import { BudgetLedger, composeAbortSignals } from "./agent/budget-ledger.js";
import { assignAgentNickname, builtinAgentProfiles, mergeUsage, selectToolsForAgentProfile, validateAgentProfileTools, type AgentProfile, type SubagentRunResult } from "./agent/profiles.js";
import { snapshotSubagentThread, subagentResultFromThread, type PendingSubagentToolUpdate, type SubagentThreadRecord, type SubagentThreadSnapshot } from "./agent/subagent-control.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { isOnlyProviderProtocolArtifacts, stripProviderProtocolArtifacts } from "./provider-artifacts.js";
import { debugReasoningStream, summarizeDebugText } from "./reasoning-debug.js";
import type { SkillSummary } from "./skills/types.js";
import type { FileStateTracker } from "./tools/file-state.js";

const MAX_CONSECUTIVE_OVERFLOW_RECOVERIES = 3;
const RESIDENT_HISTORY_KEEP_RECENT_TURNS = 3;
const RESIDENT_HISTORY_MESSAGE_LIMIT = 160;
const RESIDENT_HISTORY_CHAR_SOFT_LIMIT = 256 * 1024;
const RESIDENT_HISTORY_CHAR_HARD_LIMIT = 512 * 1024;
const RESIDENT_HISTORY_HEAP_SOFT_LIMIT = 512 * 1024 * 1024;
const RESIDENT_HISTORY_HEAP_HARD_LIMIT = 768 * 1024 * 1024;

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

  /** Whether a given tool is deferred and not yet unlocked. */
  isDeferredAndLocked(name: string): boolean {
    const tool = this.tools.get(name);
    return !!tool?.deferred && !this.unlockedDeferred.has(name);
  }

  injectSystemReminder(content: string): void {
    this.appendMessage({ role: "meta", kind: "system-reminder", content });
  }

  injectModeReminder(): void {
    this.messages = this.messages.filter((message) => !(
      message.role === "meta"
      && message.kind === "system-reminder"
      && isPermissionModeReminder(message.content)
    ));
    this.injectSystemReminder(reminderForMode(this._mode));
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
    options: { abortSignal?: AbortSignal } = {},
  ): AsyncIterable<AgentEvent> {
    const abortSignal = composeAbortSignals([options.abortSignal, this.budgetLedger?.signal]);
    throwIfAborted(abortSignal);
    const hookBus = new HookBus();
    for (const hooks of createDefaultHooks()) {
      hookBus.register(hooks);
    }
    for (const hooks of this.hookDefinitions) {
      hookBus.register(hooks);
    }
    const hookState = {};
    const reminderQueue: string[] = [];
    const queueReminder = (reminder: string) => {
      reminderQueue.push(reminder);
    };
    const flushGovernorReminders = () => {
      for (const reminder of reminderQueue.splice(0, reminderQueue.length)) {
        this.injectSystemReminder(reminder);
      }
    };

    if (this._todos.length > 0 && this._todos.every((t) => t.status === "completed")) {
      this.setTodos([]);
      yield { type: "todos_updated", todos: [] };
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
    let step = 0;

    while (true) {
      throwIfAborted(abortSignal);
      flushGovernorReminders();
      for (const update of this.drainSubagentToolUpdates()) yield update;
      yield { type: "turn_start" };
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
      };

      const streamingToolCalls = new Map<string, { id: string; name: string; args: string; argsCorrupt?: boolean }>();
      let turnUsage: TokenUsage | undefined;
      let assistantAppended = false;

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
      if (this._mode !== "plan") {
        toolEntries = toolEntries.filter((t) => t.name !== "exit_plan_mode");
      }
      flushGovernorReminders();
      const toolDefinitions: ToolDefinition[] = (((hookState as any).forceTextOnlyReason ? [] : toolEntries))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));

      try {
        const projectedMessages = projectMessages(this.messages, {
          mode: "budgeted",
          providerId: this.providerId,
          modelId: this.apiModel,
          usageAnchorTokens: this.lastInputTokens ?? undefined,
          anchorMessageCount: this.lastAnchorMessageCount ?? undefined,
        });
        const stream = this.provider.streamChat(projectedMessages, {
          model: this.apiModel,
          tools: toolDefinitions,
          temperature: this.temperature,
          thinkingLevel: this.thinkingLevel,
          abortSignal,
        });

        for await (const chunk of stream) {
          throwIfAborted(abortSignal);
          switch (chunk.type) {
            case "text":
              assistantMsg.content += chunk.content;
              yield { type: "text_delta", content: chunk.content };
              break;
            case "reasoning_delta":
              debugReasoningStream({
                stage: "agent_receive",
                providerId: this._providerId,
                modelId: this.apiModel,
                turnStep: step,
                beforeLength: assistantMsg.reasoning?.length ?? 0,
                delta: summarizeDebugText(chunk.content),
                afterLength: (assistantMsg.reasoning?.length ?? 0) + chunk.content.length,
              });
              assistantMsg.reasoning = (assistantMsg.reasoning || "") + chunk.content;
              yield { type: "reasoning_delta", content: chunk.content };
              break;

            case "tool_call":
              if (chunk.isStart) {
                streamingToolCalls.set(chunk.id, { id: chunk.id, name: chunk.name, args: "" });
                yield { type: "tool_call_start", id: chunk.id, name: chunk.name };
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
                  yield {
                    type: "tool_call_delta",
                    id: currentToolCall.id,
                    name: currentToolCall.name,
                    argumentsDelta: chunk.arguments,
                    arguments: currentToolCall.args,
                  };
                }
              }
              if (chunk.isEnd && currentToolCall) {
                assistantMsg.toolCalls!.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  arguments: currentToolCall.args,
                  ...(currentToolCall.argsCorrupt ? { argsCorrupt: true } : {}),
                });
                yield {
                  type: "tool_call_end",
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  arguments: currentToolCall.args,
                };
                streamingToolCalls.delete(chunk.id);
              }
              break;

            case "usage":
              turnUsage = chunk.usage;
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
          for (const update of this.drainSubagentToolUpdates()) yield update;
        }

        throwIfAborted(abortSignal);
        this.appendMessage(assistantMsg);
        assistantAppended = true;
      } catch (error) {
        if (assistantAppended) {
          throw error;
        }
        if (!isContextOverflowError(error)) {
          throw error;
        }
        if (consecutiveOverflowRecoveries >= MAX_CONSECUTIVE_OVERFLOW_RECOVERIES) {
          throw error;
        }
        const droppedMessages = await this.recoverFromOverflow(consecutiveOverflowRecoveries);
        consecutiveOverflowRecoveries += 1;
        yield { type: "context_recovered", droppedMessages, reason: "overflow" };
        continue;
      }

      consecutiveOverflowRecoveries = 0;

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

        const executedResults: ToolResult[] = [];
        for (let index = 0; index < parsedCalls.length; index++) {
          throwIfAborted(abortSignal);
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
          yield { type: "tool_start", id: tc.id, name: tc.name, args: tc.parsedArgs };
          const todosVersionBefore = this._todosVersion;
          const modeVersionBefore = this._modeVersion;
          const updateQueue = createUpdateQueue<ToolUpdate>();
          let result: ToolResult;
          if (blockedResult) {
            result = blockedResult;
          } else {
            const toolExecution = this.executeTool(tc, cwd, abortSignal, (update) => updateQueue.push(update));
            let settled = false;
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
                yield { type: "tool_update", id: tc.id, name: tc.name, update };
              }
              for (const update of this.drainSubagentToolUpdates()) yield update;
              if (!settled) {
                await updateQueue.wait();
              }
            }
            if (rejected) throw rejected;
            result = resolved ?? { content: `Error: Tool "${tc.name}" returned no result`, isError: true };
          }
          throwIfAborted(abortSignal);
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
          this.appendMessage({
            role: "tool",
            toolCallId: tc.id,
            content: result.content,
            metadata: result.metadata,
            isError: result.isError,
          });
          this.compactResidentHistory();
          flushGovernorReminders();
          this.onToolResult?.(tc.name, result);
          executedResults.push(result);
          yield { type: "tool_end", id: tc.id, name: tc.name, result };
          for (const update of this.drainSubagentToolUpdates()) yield update;
          if (this._todosVersion !== todosVersionBefore) {
            yield { type: "todos_updated", todos: this.getTodos() };
          }
          if (this._modeVersion !== modeVersionBefore) {
            yield { type: "mode_changed", mode: this._mode };
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

        yield { type: "turn_end", usage: turnUsage, willContinue: true };

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
      yield { type: "turn_end", usage: turnUsage, willContinue };
      if (willContinue) {
        delete (hookState as any).forceContinuationReason;
        continue;
      }
      break;
    }

    for (const update of this.drainSubagentToolUpdates()) yield update;
    yield { type: "agent_end" };
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

    const fallback = compactMessages(this.messages, { keepRecentTurns });
    if (fallback.compacted && fallback.messages) {
      this.messages = fallback.messages;
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

  private createSubagentThreadRecord(options: {
    profile: AgentProfile;
    task: string;
    runId?: string;
    agentId?: string;
    parentToolCallId: string;
    parentToolName: string;
    nickname?: string;
  }): SubagentThreadRecord {
    const now = Date.now();
    const nickname = options.nickname ?? assignAgentNickname(options.profile, this.activeSubagentNicknames());
    return {
      agentId: options.agentId ?? randomUUID(),
      runId: options.runId ?? randomUUID(),
      nickname,
      profile: options.profile,
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
    const subAgent = options.reuseAgent && record.agent
      ? record.agent
      : this.createSubAgentInstance(record, tools, cwd, options.forkContext);
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

  private createSubAgentInstance(
    record: SubagentThreadRecord,
    tools: ToolRegistryEntry[],
    cwd: string,
    forkContext?: boolean,
  ): NonNullable<SubagentThreadRecord["agent"]> {
    const childToolNames = tools.map((tool) => tool.name);
    const childSystemPrompt = buildSystemPrompt({
      agentName: "Bubble",
      configuredProvider: this.providerId || "none",
      configuredModel: this.model || "none",
      configuredModelId: this.model || "none",
      thinkingLevel: this.thinkingLevel,
      mode: "plan",
      workingDir: cwd,
      tools: childToolNames,
      skills: childToolNames.includes("skill") ? this.skillSummaries : undefined,
      memoryPrompt: childToolNames.some((name) => name === "memory_search" || name === "memory_read_summary")
        ? this.memoryPrompt
        : undefined,
      agentProfilePrompt: [
        `You are subagent ${record.nickname}. Your agent profile is ${record.profile.name}.`,
        record.profile.prompt,
      ].filter(Boolean).join("\n\n"),
    });
    const subAgent = new Agent({
      provider: this.provider,
      providerId: this.providerId,
      model: record.profile.model && record.profile.model !== "inherit" ? record.profile.model : this.model,
      tools,
      temperature: this.temperature,
      thinkingLevel: this.thinkingLevel,
      mode: "plan",
      maxTurns: record.profile.maxTurns,
      budgetLedger: this.budgetLedger,
      budgetSource: { runId: record.runId, subAgentId: record.agentId },
      systemPrompt: childSystemPrompt,
      hooks: this.hookDefinitions,
    });
    if (forkContext) {
      subAgent.messages = this.forkMessagesForSubagent(childSystemPrompt);
    }
    return subAgent;
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
      || residentChars >= RESIDENT_HISTORY_CHAR_SOFT_LIMIT
      || heapUsed >= RESIDENT_HISTORY_HEAP_SOFT_LIMIT;

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
    this.messages.push(message);
    this.onMessageAppend?.(message);
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
          `In plan mode you may only use read-only tools (read, glob, grep, lsp, web_search, web_fetch, spawn_agent, wait_agent, send_input, close_agent, skill, todo_write, tool_search, question, exit_plan_mode). ` +
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

    const missingRequired = findMissingRequiredArgs(tool.parameters, toolCall.parsedArgs);
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
      return await tool.execute(toolCall.parsedArgs, {
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new AgentAbortError(typeof reason === "string" ? reason : undefined);
}

function createUpdateQueue<T>() {
  const items: T[] = [];
  let waiter: (() => void) | undefined;
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
    wait(): Promise<void> {
      if (items.length > 0) return Promise.resolve();
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    wake() {
      const resolve = waiter;
      waiter = undefined;
      resolve?.();
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
  // If the subagent actually invoked any tool, always solicit an explicit final
  // summary. We cannot tell from the stream alone whether a tool-free trailing
  // turn was the real answer or mid-thought narration ("Let me try X next:").
  // Asking the model to restate its findings is cheap and yields predictable,
  // clean output. (Profile-validation notes in `toolNotes` do not count as
  // actual tool executions.)
  if (executedAnyTool) return true;
  if (!record.summary) return false;
  if (isOnlyProviderProtocolArtifacts(record.summary)) return true;
  if (/<\/?[｜|][^<>]*>/.test(record.summary)) return true;
  return false;
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

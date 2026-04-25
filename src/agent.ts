/**
 * Agent - The core decision loop.
 * It maintains message state, calls the LLM, executes tools, and auto-continues.
 */

import { compactMessages } from "./context/compact.js";
import { compactMessagesWithLLM } from "./context/compact-llm.js";
import { getContextBudget } from "./context/budget.js";
import { isContextOverflowError } from "./context/overflow.js";
import { projectMessages } from "./context/projector.js";
import { aggressivePruneMessages } from "./context/prune.js";
import { buildDeferredToolsReminder, buildToolFreezeReminder, reminderForMode } from "./prompt/reminders.js";
import type { AgentEvent, ContentPart, PermissionMode, Message, ParsedToolCall, Provider, ThinkingLevel, Todo, TokenUsage, ToolDefinition, ToolResult, ToolRegistryEntry } from "./types.js";
import { HookBus, type TurnHooks } from "./orchestrator/hooks.js";
import { createDefaultHooks } from "./orchestrator/default-hooks.js";
import { filterToolsForSubtask, getSubtaskPolicy, type SubtaskType } from "./agent/subtask-policy.js";

const MAX_CONSECUTIVE_OVERFLOW_RECOVERIES = 3;
const RESIDENT_HISTORY_KEEP_RECENT_TURNS = 3;
const RESIDENT_HISTORY_MESSAGE_LIMIT = 160;
const RESIDENT_HISTORY_CHAR_SOFT_LIMIT = 256 * 1024;
const RESIDENT_HISTORY_CHAR_HARD_LIMIT = 512 * 1024;
const RESIDENT_HISTORY_HEAP_SOFT_LIMIT = 512 * 1024 * 1024;
const RESIDENT_HISTORY_HEAP_HARD_LIMIT = 768 * 1024 * 1024;

export interface AgentOptions {
  provider: Provider;
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
}

export class Agent {
  messages: Message[] = [];
  private provider: Provider;
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
  private lastInputTokens: number | null = null;
  private lastAnchorMessageCount: number | null = null;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
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

    if (options.systemPrompt) {
      this.messages.push({ role: "system", content: options.systemPrompt });
    }

    for (const tool of options.tools) {
      this.tools.set(tool.name, tool);
    }

    // If the agent boots in a non-default mode, inject the corresponding reminder so the
    // model sees the active rules on its very first turn. Default mode needs no reminder.
    if (this._mode !== "default") {
      this.injectSystemReminder(reminderForMode(this._mode));
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
    this.appendMessage({ role: "user", content, isMeta: true });
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
    this.injectSystemReminder(reminderForMode(value));
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

  async *run(userInput: string | ContentPart[], cwd: string): AsyncIterable<AgentEvent> {
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
      flushGovernorReminders();
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

      let currentToolCall: { id: string; name: string; args: string } | null = null;
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
        });

        for await (const chunk of stream) {
          switch (chunk.type) {
            case "text":
              assistantMsg.content += chunk.content;
              yield { type: "text_delta", content: chunk.content };
              break;
            case "reasoning_delta":
              assistantMsg.reasoning = (assistantMsg.reasoning || "") + chunk.content;
              yield { type: "reasoning_delta", content: chunk.content };
              break;

            case "tool_call":
              if (chunk.isStart) {
                currentToolCall = { id: chunk.id, name: chunk.name, args: "" };
              }
              if (currentToolCall) {
                currentToolCall.args += chunk.arguments;
              }
              if (chunk.isEnd && currentToolCall) {
                assistantMsg.toolCalls!.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  arguments: currentToolCall.args,
                });
                currentToolCall = null;
              }
              break;

            case "usage":
              turnUsage = chunk.usage;
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
        }

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
            parsedCalls.push({ ...tc, parsedArgs: JSON.parse(tc.arguments) });
          } catch {
            parsedCalls.push({ ...tc, parsedArgs: {} });
          }
        }

        const executedResults: ToolResult[] = [];
        for (let index = 0; index < parsedCalls.length; index++) {
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
          let result = blockedResult ?? await this.executeTool(tc, cwd);
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
          });
          this.compactResidentHistory();
          flushGovernorReminders();
          this.onToolResult?.(tc.name, result);
          executedResults.push(result);
          yield { type: "tool_end", id: tc.id, name: tc.name, result };
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

        yield { type: "turn_end", usage: turnUsage };

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
      yield { type: "turn_end", usage: turnUsage };
      break;
    }

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
      return before - this.messages.length;
    }

    const fallback = compactMessages(this.messages, { keepRecentTurns });
    if (fallback.compacted && fallback.messages) {
      this.messages = fallback.messages;
      this.lastInputTokens = null;
      this.lastAnchorMessageCount = null;
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
    const policy = getSubtaskPolicy(subtaskType);
    const tools = filterToolsForSubtask(
      [...this.tools.values()].filter((tool) => tool.name !== "task"),
      subtaskType,
    );
    const subAgent = new Agent({
      provider: this.provider,
      providerId: this.providerId,
      model: this.model,
      tools,
      temperature: this.temperature,
      thinkingLevel: this.thinkingLevel,
      mode: "plan",
      maxTurns: policy.maxTurns,
      taskBudget: policy.taskBudget,
      systemPrompt: this.messages.find((message) => message.role === "system")?.content,
      hooks: this.hookDefinitions,
    });
    subAgent.injectSystemReminder(`<system-reminder>\n${policy.reminder}\n</system-reminder>`);

    let summary = "";
    const toolNotes: string[] = [];
    for await (const event of subAgent.run(input, cwd)) {
      if (event.type === "text_delta") {
        summary += event.content;
      }
      if (event.type === "tool_end") {
        const detail = event.result.metadata?.reason
          || event.result.content.split("\n").find((line) => line.trim())?.trim()
          || "completed";
        toolNotes.push(`${event.name}: ${detail}`);
      }
    }

    const lines: string[] = [];
    const trimmedSummary = summary.trim();
    lines.push(`Subtask type: ${policy.type}`);
    if (options?.description) {
      lines.push(`Subtask description: ${options.description}`);
    }
    if (trimmedSummary) {
      lines.push("", "Subtask summary:", trimmedSummary);
    }
    if (toolNotes.length > 0) {
      lines.push("", "Subtask tools:");
      for (const note of toolNotes.slice(0, 8)) {
        lines.push(`- ${note}`);
      }
    }
    if (lines.length === 0) {
      lines.push("Subtask summary:", "No conclusive findings were produced.");
    }

    return {
      content: lines.join("\n"),
      status: policy.resultStatus,
      metadata: {
        kind: "security",
        reason: `Subtask (${policy.type}) investigation completed.`,
      },
    };
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
        candidate = compacted.messages;
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
    }
  }

  private appendMessage(message: Message) {
    this.messages.push(message);
    this.onMessageAppend?.(message);
  }

  private async executeTool(toolCall: ParsedToolCall, cwd: string): Promise<ToolResult> {
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
          `In plan mode you may only use read-only tools (read, grep, web_search, web_fetch, task, skill). ` +
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

    try {
      return await tool.execute(toolCall.parsedArgs, { cwd, agent: this });
    } catch (err: any) {
      return {
        content: `Error executing ${toolCall.name}: ${err.message || String(err)}`,
        isError: true,
      };
    }
  }
}

function estimateResidentChars(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    switch (message.role) {
      case "system":
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

function estimateToolPayloadChars(messages: Message[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== "tool") {
      return sum;
    }
    return sum + message.content.length;
  }, 0);
}

function countUserTurns(messages: Message[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" && !message.isMeta ? 1 : 0), 0);
}

function getCurrentHeapUsed(): number {
  try {
    return process.memoryUsage().heapUsed;
  } catch {
    return 0;
  }
}

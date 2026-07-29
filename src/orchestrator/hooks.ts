import type { Agent } from "../agent.js";
import type { ContentPart, ParsedToolCall, ToolRegistryEntry, ToolResult } from "../types.js";
import type { GitChangeBaseline } from "../agent/change-tracker.js";

export interface TurnHookState {
  turnCount?: number;
  forceTextOnlyReason?: string;
  forceContinuationReason?: string;
  /** Modified-existing-tests disclosure already delivered this run (at most once). */
  testsTouchedDisclosed?: boolean;
  /** Git dirty-state snapshot at run start (null = not a git repo / git failed). */
  gitBaseline?: GitChangeBaseline | null;
  /** Any tool executed this run — guards git-change attribution for pure Q&A turns. */
  toolUsed?: boolean;
  taskBudget?: {
    total: number;
    spent: number;
  };
}

export interface TurnHookContext {
  agent: Agent;
  cwd: string;
  input: string | ContentPart[];
  state: TurnHookState;
  queueReminder: (reminder: string) => void;
  flushReminders: () => void;
}

export interface BeforeModelCallHookContext extends TurnHookContext {
  toolEntries: ToolRegistryEntry[];
  disableTools: (reason: string) => void;
}

export interface BeforeToolCallHookContext extends TurnHookContext {
  toolCall: ParsedToolCall;
  blockedResult?: ToolResult;
  replaceToolCall: (toolCall: ParsedToolCall) => void;
  blockToolCall: (result: ToolResult) => void;
}

export interface AfterToolCallHookContext extends TurnHookContext {
  toolCall: ParsedToolCall;
  result: ToolResult;
  replaceResult: (result: ToolResult) => void;
}

export interface BeforeContinuationHookContext extends TurnHookContext {
  toolCalls: ParsedToolCall[];
  toolResults: ToolResult[];
  requestTextOnlyTurn: (reason: string) => void;
}

export interface TurnHooks {
  beforeTurn?: (ctx: TurnHookContext) => void | Promise<void>;
  beforeModelCall?: (ctx: BeforeModelCallHookContext) => void | Promise<void>;
  beforeToolCall?: (ctx: BeforeToolCallHookContext) => void | Promise<void>;
  afterToolCall?: (ctx: AfterToolCallHookContext) => void | Promise<void>;
  beforeContinuation?: (ctx: BeforeContinuationHookContext) => void | Promise<void>;
  afterTurn?: (ctx: TurnHookContext) => void | Promise<void>;
}

export class HookBus {
  private beforeTurnHooks: Array<NonNullable<TurnHooks["beforeTurn"]>> = [];
  private beforeModelCallHooks: Array<NonNullable<TurnHooks["beforeModelCall"]>> = [];
  private beforeToolCallHooks: Array<NonNullable<TurnHooks["beforeToolCall"]>> = [];
  private afterToolCallHooks: Array<NonNullable<TurnHooks["afterToolCall"]>> = [];
  private beforeContinuationHooks: Array<NonNullable<TurnHooks["beforeContinuation"]>> = [];
  private afterTurnHooks: Array<NonNullable<TurnHooks["afterTurn"]>> = [];

  register(hooks: TurnHooks): void {
    if (hooks.beforeTurn) this.beforeTurnHooks.push(hooks.beforeTurn);
    if (hooks.beforeModelCall) this.beforeModelCallHooks.push(hooks.beforeModelCall);
    if (hooks.beforeToolCall) this.beforeToolCallHooks.push(hooks.beforeToolCall);
    if (hooks.afterToolCall) this.afterToolCallHooks.push(hooks.afterToolCall);
    if (hooks.beforeContinuation) this.beforeContinuationHooks.push(hooks.beforeContinuation);
    if (hooks.afterTurn) this.afterTurnHooks.push(hooks.afterTurn);
  }

  async runBeforeTurn(ctx: TurnHookContext): Promise<void> {
    for (const hook of this.beforeTurnHooks) {
      await hook(ctx);
    }
  }

  async runBeforeModelCall(ctx: BeforeModelCallHookContext): Promise<void> {
    for (const hook of this.beforeModelCallHooks) {
      await hook(ctx);
    }
  }

  async runBeforeToolCall(ctx: BeforeToolCallHookContext): Promise<void> {
    for (const hook of this.beforeToolCallHooks) {
      await hook(ctx);
    }
  }

  async runAfterToolCall(ctx: AfterToolCallHookContext): Promise<void> {
    for (const hook of this.afterToolCallHooks) {
      await hook(ctx);
    }
  }

  async runBeforeContinuation(ctx: BeforeContinuationHookContext): Promise<void> {
    for (const hook of this.beforeContinuationHooks) {
      await hook(ctx);
    }
  }

  async runAfterTurn(ctx: TurnHookContext): Promise<void> {
    for (const hook of this.afterTurnHooks) {
      await hook(ctx);
    }
  }
}

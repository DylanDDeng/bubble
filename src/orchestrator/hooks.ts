import type { Agent } from "../agent.js";
import type { ContentPart, ParsedToolCall, ToolRegistryEntry, ToolResult } from "../types.js";
import type { TaskType } from "../agent/task-classifier.js";
import type { ExecutionGovernor } from "../agent/execution-governor.js";
import type { EvidenceTracker } from "../agent/evidence-tracker.js";
import type { DiscoveryBarrier } from "../agent/discovery-barrier.js";
import type { WorkflowPhase } from "./workflow.js";

export interface TurnHookState {
  taskType?: TaskType;
  governor?: ExecutionGovernor;
  discoveryBarrier?: DiscoveryBarrier;
  evidenceTracker?: EvidenceTracker;
  workflowPhase?: WorkflowPhase;
  workflowKey?: string;
  turnCount?: number;
  forceTextOnlyReason?: string;
  forceContinuationReason?: string;
  codeChanged?: boolean;
  /** Completion self-check gate already fired this run (fires at most once). */
  completionGateFired?: boolean;
  smallTaskHintSent?: boolean;
  recentEditFailures?: string[];
  editNoMatchReminderPaths?: string[];
  editRetryReminderSent?: boolean;
  recentReadPaths?: string[];
  redundantReadReminded?: Set<string>;
  taskBudget?: {
    total: number;
    spent: number;
  };
  // Large-task delegation detector (large-task-delegation design §1):
  // files actually READ this turn (search results contribute nothing).
  exploredFiles?: Set<string>;
  /** Checkpoint evaluated at the first mutation — once per turn, fired or not. */
  largeTaskCheckpointDone?: boolean;
  /** Successful mutations this turn; rendered as K in the nudge wording. */
  appliedEditCount?: number;
  /** orchestrationRequestReminder fired: the nudge offers only run_workflow. */
  orchestrationReminderSent?: boolean;
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
  toolCall: ParsedToolCall & { arbiterNote?: string };
  blockedResult?: ToolResult;
  replaceToolCall: (toolCall: ParsedToolCall & { arbiterNote?: string }) => void;
  blockToolCall: (result: ToolResult) => void;
}

export interface AfterToolCallHookContext extends TurnHookContext {
  toolCall: ParsedToolCall & { arbiterNote?: string };
  result: ToolResult;
  replaceResult: (result: ToolResult) => void;
}

export interface BeforeContinuationHookContext extends TurnHookContext {
  toolCalls: Array<ParsedToolCall & { arbiterNote?: string }>;
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

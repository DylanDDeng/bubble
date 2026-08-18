/**
 * Pure Agent-event reducer for a single agent run.
 *
 * Mechanical extraction of the switch in src/tui-ink/app.tsx:1657-1854 plus
 * its finally-block semantics (1888-1958) into a pure function: state in,
 * (state, effects) out. No React, no Ink, no ports — the controller applies
 * effects and owns scheduling (40ms flush) via ports.
 *
 * Migration rule (docs/pi-tui-controller-extraction.md §2): each case is
 * case-for-case equivalent to the legacy implementation; no opportunistic
 * refactoring. Behavior deltas are called out in comments.
 */
import type { AgentEvent, AgentRunInput } from "../../types.js";
import { tokenUsageTotal } from "../../goal/usage.js";
import {
  appendTextPart,
  appendToolPart,
  contentFromParts,
  nextDisplayMessageKey,
  snapshotDisplayParts,
  setUserInputStatus,
  toolCallsFromParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
} from "../model/display-history.js";
import type { ControllerEffect } from "./effects.js";

export const STREAMING_FLUSH_INTERVAL_MS = 40;

/** Grok external-runtime whitelist (app.tsx:1642-1656). */
const GROK_ALLOWED_EVENTS = new Set<AgentEvent["type"]>([
  "turn_start",
  "text_delta",
  "reasoning_delta",
  "tool_start",
  "tool_update",
  "tool_end",
  "turn_end",
]);

export interface RunAccumulator {
  readonly runId: number;
  content: string;
  reasoning: string;
  systemFingerprint?: string;
  toolCalls: DisplayToolCall[];
  parts: DisplayMessagePart[];
  usageTokens: number;
  usageReported: boolean;
}

export type RunOutcome = "running" | "cancelled" | "errored";

export interface RunDirty {
  content: boolean;
  reasoning: boolean;
  parts: boolean;
  tools: boolean;
}

export interface RunState {
  readonly accumulator: RunAccumulator;
  readonly dirty: RunDirty;
  readonly outcome: RunOutcome;
}

export interface RunContext {
  readonly external: boolean;
  readonly externalModelId?: string;
  isCurrentRun(): boolean;
  now(): number;
  readonly runStartedAt: number | null;
  /** Steer placeholders correlated by input id (controller-owned map). */
  readonly pendingSteers: ReadonlyMap<string, { displayKey: string; sessionFile?: string }>;
}

export interface EventReduceResult {
  readonly state: RunState;
  readonly effects: readonly ControllerEffect[];
}

export function createRunState(runId: number): RunState {
  return {
    accumulator: {
      runId,
      content: "",
      reasoning: "",
      toolCalls: [],
      parts: [],
      usageTokens: 0,
      usageReported: false,
    },
    dirty: { content: false, reasoning: false, parts: false, tools: false },
    outcome: "running",
  };
}

/** Grok policy guard: events outside the whitelist abort the session. */
export function grokEventAllowed(event: AgentEvent): boolean {
  return GROK_ALLOWED_EVENTS.has(event.type);
}

export function reduceAgentEvent(state: RunState, event: AgentEvent, ctx: RunContext): EventReduceResult {
  const effects: ControllerEffect[] = [];
  const acc = state.accumulator;

  if (ctx.external && !grokEventAllowed(event)) {
    // app.tsx:1647-1656 — cancel the external session and fail the run.
    effects.push({ kind: "external-cancel-policy" as never });
    return { state, effects };
  }

  switch (event.type) {
    case "turn_start": {
      // app.tsx:1658-1666 — a fresh provider call discards any half-built
      // retry buffer so the retry never re-streams the same opening text.
      effects.push({ kind: "stream-cleared" });
      const fresh = createRunState(acc.runId);
      return {
        state: { ...fresh, dirty: state.dirty, outcome: state.outcome },
        effects,
      };
    }
    case "text_delta": {
      acc.content += event.content;
      appendTextPart(acc.parts, event.content);
      return { state: { ...state, dirty: { ...state.dirty, content: true, parts: true } }, effects };
    }
    case "reasoning_delta": {
      acc.reasoning += event.content;
      return { state: { ...state, dirty: { ...state.dirty, reasoning: true } }, effects };
    }
    case "tool_call_start": {
      if (!acc.toolCalls.some((t) => t.id === event.id)) {
        const toolCall: DisplayToolCall = { id: event.id, name: event.name, args: {}, startedAt: ctx.now() };
        acc.toolCalls.push(toolCall);
        appendToolPart(acc.parts, toolCall);
        effects.push({ kind: "tools-updated" });
        return { state: { ...state, dirty: { ...state.dirty, parts: true, tools: true } }, effects };
      }
      return { state, effects };
    }
    case "tool_call_delta": {
      const tc = acc.toolCalls.find((t) => t.id === event.id);
      if (tc) {
        tc.rawArguments = event.arguments;
        effects.push({ kind: "tools-updated" });
        return { state: { ...state, dirty: { ...state.dirty, tools: true } }, effects };
      }
      return { state, effects };
    }
    case "tool_call_end": {
      // app.tsx:1723-1729 — nothing visual; tool_start refreshes canonical args.
      return { state, effects };
    }
    case "tool_start": {
      const existing = acc.toolCalls.find((t) => t.id === event.id);
      if (existing) {
        existing.args = event.args;
        existing.startedAt = existing.startedAt ?? ctx.now();
      } else {
        const toolCall: DisplayToolCall = { id: event.id, name: event.name, args: event.args, startedAt: ctx.now() };
        acc.toolCalls.push(toolCall);
        appendToolPart(acc.parts, toolCall);
      }
      effects.push({ kind: "tools-updated" });
      return { state: { ...state, dirty: { ...state.dirty, parts: true, tools: true } }, effects };
    }
    case "tool_end": {
      const tc = acc.toolCalls.find((t) => t.id === event.id);
      if (tc) {
        tc.result = event.result.content;
        tc.isError = event.result.isError;
        tc.metadata = event.result.metadata;
        effects.push({ kind: "tools-updated" });
        return { state: { ...state, dirty: { ...state.dirty, tools: true } }, effects };
      }
      return { state, effects };
    }
    case "tool_update": {
      const tc = acc.toolCalls.find((t) => t.id === event.id);
      if (tc) {
        if (event.update.metadata) {
          tc.metadata = mergeMetadataShallow(tc.metadata, event.update.metadata);
        }
        if (event.update.message) {
          tc.result = event.update.message;
        }
        tc.isError = event.update.status === "failed" || event.update.status === "blocked" || event.update.status === "cancelled";
        effects.push({ kind: "tools-updated" });
        return { state: { ...state, dirty: { ...state.dirty, tools: true } }, effects };
      }
      // app.tsx:1741-1753 — the launching call already settled; a live
      // subagent update routes to the cross-round accumulator.
      effects.push({ kind: "live-subagent-changed" });
      return { state, effects };
    }
    case "mode_changed": {
      effects.push({ kind: "permission-mode-changed", mode: event.mode });
      return { state, effects };
    }
    case "input_applied": {
      const steer = ctx.pendingSteers.get(event.id);
      if (steer) {
        effects.push({ kind: "steer-applied", id: event.id, displayKey: steer.displayKey } as never);
      }
      return { state, effects };
    }
    case "input_rejected": {
      const steer = ctx.pendingSteers.get(event.id);
      if (steer) {
        effects.push({ kind: "steer-requeued", id: event.id, displayKey: steer.displayKey } as never);
      }
      return { state, effects };
    }
    case "input_pending_changed": {
      effects.push({ kind: "queue-updated", pending: event.pending } as never);
      return { state, effects };
    }
    case "turn_end": {
      if (event.usage) {
        acc.usageReported = true;
        acc.usageTokens += tokenUsageTotal(event.usage);
      }
      acc.systemFingerprint = event.systemFingerprint ?? acc.systemFingerprint;
      if (event.willContinue) {
        effects.push({ kind: "assistant-committed" });
        effects.push({ kind: "stream-cleared" });
        return { state, effects };
      }
      const elapsed = ctx.runStartedAt != null ? ctx.now() - ctx.runStartedAt : undefined;
      effects.push({ kind: "assistant-committed", taskElapsedMs: elapsed });
      effects.push({ kind: "stream-cleared" });
      return { state, effects };
    }
    default:
      // hook_*, context_recovered, provider_retry, agent_end: silently
      // ignored today (app.tsx has no cases for them).
      return { state, effects };
  }
}

export interface RunFinishOptions {
  cancelled: boolean;
  errored: boolean;
  /** Steers still pending at run end (inputController.clear() upstream). */
  leftoverSteers: Array<{ input: AgentRunInput; displayKey?: string; sessionFile?: string }>;
  /** Placeholder-row bookkeeping stays with the controller's queue state. */
  ownsCurrentGeneration: boolean;
}

/** finally-block semantics (app.tsx:1888-1958) as a pure transition. */
export function reduceRunFinish(state: RunState, opts: RunFinishOptions): EventReduceResult {
  const effects: ControllerEffect[] = [];
  const cancelled = opts.cancelled;
  const outcome: RunOutcome = cancelled ? "cancelled" : opts.errored ? "errored" : "running";

  if (opts.leftoverSteers.length > 0) {
    effects.push({ kind: "steers-drained", cancelled, leftovers: opts.leftoverSteers } as never);
  }
  if (opts.ownsCurrentGeneration) {
    effects.push({ kind: "queue-updated", pending: 0 } as never);
    effects.push({ kind: "run-finished", cancelled, errored: opts.errored } as never);
  }
  return { state: { ...state, outcome }, effects };
}

/** Build the committed assistant message from the accumulator (app.tsx:1567-1607). */
export function buildAssistantMessage(state: RunState, taskElapsedMs?: number): DisplayMessage | null {
  const acc = state.accumulator;
  const hasOutput = !!acc.content || !!acc.reasoning || acc.toolCalls.length > 0 || acc.parts.length > 0;
  if (!hasOutput) return null;

  const currentParts = snapshotDisplayParts(acc.parts);
  const currentToolCalls = [...acc.toolCalls];
  const partContent = acc.content || contentFromParts(currentParts);
  const partToolCalls = currentToolCalls.length > 0 ? currentToolCalls : toolCallsFromParts(currentParts);
  const message: DisplayMessage = { key: nextDisplayMessageKey("asst"), role: "assistant", content: partContent };
  if (acc.reasoning) message.reasoning = acc.reasoning;
  if (partToolCalls.length > 0) message.toolCalls = partToolCalls;
  if (currentParts.length > 0) message.parts = currentParts;
  if (taskElapsedMs !== undefined && Number.isFinite(taskElapsedMs) && taskElapsedMs > 0) {
    message.taskElapsedMs = taskElapsedMs;
  }
  if (acc.systemFingerprint) message.systemFingerprint = acc.systemFingerprint;
  return message;
}

function mergeMetadataShallow(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(base ?? {}), ...patch };
}

export type { setUserInputStatus };

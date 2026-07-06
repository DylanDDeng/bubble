/**
 * ChildRunner — executes one logical run of a subagent thread and reports the
 * outcome to the scheduler (design doc §2, extracted in Phase 3).
 *
 * A logical run spans dispatch → final state; a rate-limit re-entry is the
 * same logical run (no second SubagentStart), while a send_input restart is a
 * new one. The runner owns: tool validation defense, instance reuse,
 * turn-boundary budget enforcement, the handoff completeness guard, and the
 * mapping of failures to SubagentFinalReason.
 */

import { AgentAbortError, EMPTY_ASSISTANT_FALLBACK, SubagentAbortError } from "./abort-errors.js";
import { composeAbortSignals } from "./budget-ledger.js";
import { isOnlyProviderProtocolArtifacts, stripProviderProtocolArtifacts } from "../provider-artifacts.js";
import { isRateLimitError } from "../network/errors.js";
import { isProviderTransportError } from "../network/provider-transport.js";
import { mergeUsage, selectToolsForAgentProfile, validateAgentProfileTools } from "./profiles.js";
import {
  estimateHandoffTokens,
  HANDOFF_TOKEN_FLOOR,
  isIntermediateHandoff,
  stripInternalTagFragments,
} from "./subagent-summary.js";
import type { SubagentRunOutcome } from "./subagent-scheduler.js";
import type { SubagentFinalReason, SubagentThreadRecord } from "./subagent-control.js";
import type { AgentEvent, Message, ToolRegistryEntry, ToolResult, ToolUpdate } from "../types.js";

export interface ChildRunOptions {
  approval: "fail" | "disabled";
  abortSignal?: AbortSignal;
  forkContext?: boolean;
  directEmit?: (update: ToolUpdate) => void;
  queueUpdates?: boolean;
  reuseAgent?: boolean;
  /** 1-based scheduler attempt; >1 means rate-limit re-entry of the same logical run. */
  attempt?: number;
}

export interface ChildRunnerHost {
  allTools(): ToolRegistryEntry[];
  emit(record: SubagentThreadRecord, options: ChildRunOptions, status: ToolUpdate["status"], event?: AgentEvent, message?: string): void;
  runLifecycleHook(record: SubagentThreadRecord, cwd: string, eventName: "SubagentStart" | "SubagentStop", status?: string, error?: string, abortSignal?: AbortSignal): Promise<void>;
  finalizeBlocked(record: SubagentThreadRecord, error: string, options: ChildRunOptions): void;
  createInstance(record: SubagentThreadRecord, tools: ToolRegistryEntry[], cwd: string, forkContext?: boolean): Promise<NonNullable<SubagentThreadRecord["agent"]>>;
  notifyWaiters(record: SubagentThreadRecord): void;
  /** Called on every final state so background results can be ingested (§5). */
  onFinal(record: SubagentThreadRecord, options: ChildRunOptions): void;
}

export class ChildRunner {
  constructor(private readonly host: ChildRunnerHost) {}

  async run(
    record: SubagentThreadRecord,
    input: string | import("../types.js").ContentPart[],
    cwd: string,
    options: ChildRunOptions,
  ): Promise<SubagentRunOutcome> {
    const attempt = options.attempt ?? 1;
    const emit = (status: ToolUpdate["status"], event?: AgentEvent, message?: string) =>
      this.host.emit(record, options, status, event, message);

    const allTools = this.host.allTools();
    const diagnostics = validateAgentProfileTools(allTools, record.profile, options.approval);
    const blockingDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (attempt === 1) {
      for (const diagnostic of diagnostics.filter((item) => item.severity === "warning")) {
        record.toolNotes.push(`profile: ${diagnostic.message}`);
      }
    }
    if (blockingDiagnostics.length > 0) {
      this.host.finalizeBlocked(record, blockingDiagnostics.map((diagnostic) => diagnostic.message).join("\n"), options);
      this.host.onFinal(record, options);
      return { kind: "final" };
    }

    const tools = selectToolsForAgentProfile(allTools, record.profile, options.approval);
    const reuseExistingAgent = (options.reuseAgent || attempt > 1) && !!record.agent;
    let subAgent: NonNullable<SubagentThreadRecord["agent"]>;
    try {
      subAgent = reuseExistingAgent
        ? record.agent!
        : await this.host.createInstance(record, tools, cwd, options.forkContext);
    } catch (error: any) {
      // Instance creation failed before the run started: no SubagentStart
      // fired, so no SubagentStop follows (§9 — hooks pair per started run).
      this.host.finalizeBlocked(record, error?.message || String(error), options);
      record.finalReason = "failed_fatal";
      this.host.onFinal(record, options);
      return { kind: "final" };
    }
    record.agent = subAgent;
    // Write children run inside their isolated worktree (design §8).
    const runCwd = record.worktree?.path ?? cwd;
    record.status = "running";
    record.updatedAt = Date.now();
    // SubagentStart fires exactly once per logical run (design §9): a
    // rate-limit re-entry is the same logical run and must not re-fire it.
    if (attempt === 1) {
      await this.host.runLifecycleHook(record, cwd, "SubagentStart", record.status, undefined, options.abortSignal);
    }
    emit("running", undefined, attempt > 1
      ? `Retrying ${record.nickname} (${record.profile.name}) after a rate limit, attempt ${attempt}...`
      : `Running ${record.nickname} (${record.profile.name})...`);
    let turnSummaryBuffer = "";
    let turnHadToolCall = false;
    let executedAnyTool = false;

    // Re-entry after a rate limit: the input was applied on attempt 1, so the
    // child history must not gain a second copy, and any stale interruption
    // boundary from the failed call is stripped (design §4.5).
    const resumeWithoutInput = attempt > 1;
    if (resumeWithoutInput) {
      stripTrailingModelInterruptedBoundary(subAgent.messages);
    }

    try {
      const childAbortSignal = composeAbortSignals([
        options.abortSignal,
        record.abortController.signal,
      ]);
      for await (const event of subAgent.run(input, runCwd, { abortSignal: childAbortSignal, resumeWithoutInput })) {
        if (event.type === "turn_start") {
          // Leftovers here belong to a half-built attempt the agent discarded
          // (stream-interruption retry re-issues the whole request); keeping
          // them would duplicate the retried text in the turn summary.
          turnSummaryBuffer = "";
          turnHadToolCall = false;
        }
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
      if (
        isRateLimitError(error)
        && !record.abortController.signal.aborted
        && !options.abortSignal?.aborted
      ) {
        // Not a failure: keep the agent instance and its context, hand the
        // backoff decision to the scheduler — the single 429 backoff layer.
        record.status = "queued";
        record.summary = sanitizeSubagentSummary(record.summary);
        record.updatedAt = Date.now();
        stripTrailingModelInterruptedBoundary(subAgent.messages);
        emit("queued", undefined, `Rate limited; ${record.nickname} will retry with its context intact.`);
        return { kind: "rate_limited", retryAfterMs: error.retryAfterMs };
      }
      const abortedNow = record.abortController.signal.aborted
        || options.abortSignal?.aborted
        || error instanceof AgentAbortError
        || error?.name === "AbortError";
      if (!abortedNow && isProviderTransportError(error)) {
        // A transient transport failure (connection error or request timeout)
        // is recoverable: keep the agent and its context, strip any stale
        // "[model request interrupted...]" boundary, and hand the bounded
        // backoff to the scheduler — the same shape as the 429 requeue above.
        // Restarting the whole logical run covers both a connection-phase
        // timeout (thrown before any chunk) and a mid-stream one (boundary
        // appended). The abort guard ensures a genuine user cancel is never
        // requeued; a Bun TimeoutError (name "TimeoutError") is not an abort.
        record.status = "queued";
        record.summary = sanitizeSubagentSummary(record.summary);
        record.updatedAt = Date.now();
        stripTrailingModelInterruptedBoundary(subAgent.messages);
        emit("queued", undefined, `Connection error; ${record.nickname} will retry with its context intact.`);
        return { kind: "transport_retry" };
      }
      const cancelled = error instanceof AgentAbortError || error?.name === "AbortError";
      record.status = cancelled ? "cancelled" : "failed";
      record.finalReason = cancelled
        ? classifySubagentAbortReason(
          record.abortController.signal.aborted ? record.abortController.signal.reason : error,
          options.abortSignal,
        )
        : "failed_transient";
      record.summary = sanitizeSubagentSummary(record.summary);
      record.error = error?.message || String(error);
      record.updatedAt = Date.now();
      await this.host.runLifecycleHook(record, cwd, "SubagentStop", record.status, record.error, options.abortSignal);
      emit(record.status, undefined, record.error);
      this.host.notifyWaiters(record);
      this.host.onFinal(record, options);
      return { kind: "final" };
    }

    record.summary = sanitizeSubagentSummary(record.summary);
    if (needsExplicitFinalSummary(record, executedAnyTool)) {
      await this.runFinalSummaryTurn(record, subAgent, runCwd, options.abortSignal, emit);
    }

    record.status = "completed";
    record.finalReason = "completed";
    record.summary = sanitizeSubagentSummary(record.summary);
    record.updatedAt = Date.now();
    await this.host.runLifecycleHook(record, cwd, "SubagentStop", record.status, undefined, options.abortSignal);
    emit("completed", undefined, record.summary || `${record.nickname} completed`);
    this.host.notifyWaiters(record);
    this.host.onFinal(record, options);
    return { kind: "final" };
  }

  private async runFinalSummaryTurn(
    record: SubagentThreadRecord,
    subAgent: NonNullable<SubagentThreadRecord["agent"]>,
    cwd: string,
    abortSignal: AbortSignal | undefined,
    emit: (status: ToolUpdate["status"], event?: AgentEvent, message?: string) => void,
  ): Promise<void> {
    const prompt = [
      "Produce the final subagent handoff now: what you found, your conclusions, and any unfinished items.",
      "Do not call tools. Do not announce next steps or plans.",
      "Use the evidence already gathered in this child thread.",
      "Return concise findings with concrete file paths and explicit uncertainty.",
      "If your previous message already was the complete handoff, restate it as-is — do not pad it.",
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
      if (event.type === "turn_start") {
        // Discarded stream-interruption attempt — drop its partial text so the
        // retried response doesn't carry a duplicated prefix.
        finalBuffer = "";
      }
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
    // The follow-up may only improve the handoff: an empty or fallback
    // response must never replace a real (if short) summary.
    if (!finalHadToolCall && finalSummary && finalSummary !== EMPTY_ASSISTANT_FALLBACK) {
      record.summary = finalSummary;
    }
  }
}

export function sanitizeSubagentSummary(value: string): string {
  return stripInternalTagFragments(stripProviderProtocolArtifacts(value)).trim();
}

/**
 * Handoff completeness guard (design §3.2): a deterministic CJK-aware token
 * floor and a cheap intermediate-narration prefix check run in parallel.
 * Both only apply after the child actually used tools — a short direct answer
 * to a trivial question is a complete handoff.
 */
export function needsExplicitFinalSummary(record: SubagentThreadRecord, executedAnyTool: boolean): boolean {
  if (!record.summary) return executedAnyTool;
  if (isOnlyProviderProtocolArtifacts(record.summary)) return true;
  if (/<\/?[｜|][^<>]*>/.test(record.summary)) return true;
  if (!executedAnyTool) return false;
  if (record.summary === EMPTY_ASSISTANT_FALLBACK) return true;
  // A schema-bearing child's handoff is a compact JSON value; short is
  // complete by construction, and a restate turn would risk breaking the JSON.
  if (!record.expectsStructuredOutput && estimateHandoffTokens(record.summary) < HANDOFF_TOKEN_FLOOR) return true;
  return isIntermediateHandoff(record.summary);
}

export function classifySubagentAbortReason(
  reason: unknown,
  parentSignal: AbortSignal | undefined,
): SubagentFinalReason {
  if (reason instanceof SubagentAbortError) {
    switch (reason.subagentReason) {
      case "interrupt":
        return "cancelled_interrupt";
      case "user_close":
        return "cancelled_user";
    }
  }
  if (parentSignal?.aborted) return "cancelled_parent_abort";
  return "cancelled_user";
}

/**
 * Drops trailing "[model request interrupted ...]" boundary messages so a
 * rate-limit re-entry resumes from clean history (design §4.5).
 */
export function stripTrailingModelInterruptedBoundary(messages: Message[]): void {
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === "assistant" && last.content.startsWith("[model request interrupted")) {
      messages.pop();
      continue;
    }
    break;
  }
}

export function summarizeSubagentToolEnd(event: { name: string; result: ToolResult }): string {
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
  if (path) {
    if (kind === "read") {
      const offset = readNumber(metadata.offset);
      const lines = readNumber(metadata.lines);
      const total = readNumber(metadata.total);
      // Show the range only for partial/paged reads so N distinct slice-reads
      // stop collapsing into identical "read PATH" notes; a plain full read
      // still renders as "read PATH".
      if (offset !== undefined && lines !== undefined && (offset > 1 || (total !== undefined && lines < total))) {
        return `read ${path} (lines ${offset}-${offset + lines - 1})`;
      }
    }
    return kind ? `${kind} ${path}` : path;
  }
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

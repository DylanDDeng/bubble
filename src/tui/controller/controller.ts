/**
 * BubbleTuiController — the framework-neutral runtime orchestrator
 * (design doc §8.1). Assembles the extracted sub-modules:
 *
 *   - agent-event-reducer (stream/tool/turn semantics)
 *   - input-queue-machine (steer/queue lifecycle)
 *   - overlay-controller (blocking request lifecycle)
 *   - session-transition (two-phase atomic switch)
 *   - task-runtime-controller (task markers/wakes)
 *
 * The controller consumes an Agent event stream, applies effects, batches
 * streaming updates behind the 40ms FlushScheduler, and publishes immutable
 * snapshots. Renderers subscribe; they never mutate.
 */
import type { Agent, AgentRunOptions } from "../../agent.js";
import type { SessionManager } from "../../session.js";
import type { BubbleTuiPorts } from "./ports.js";
import { ControllerState } from "./state.js";
import type { ControllerEffect } from "./effects.js";
import {
  buildAssistantMessage,
  createRunState,
  reduceAgentEvent,
  reduceRunFinish,
  STREAMING_FLUSH_INTERVAL_MS,
  type RunContext,
  type RunState,
} from "./agent-event-reducer.js";
import {
  beginSteer,
  createInputQueueState,
  drainLeftoverSteers,
  purgeForSessionSwitch,
  type InputQueueState,
} from "./input-queue-machine.js";
import { AgentRunInputQueue } from "../../agent/input-controller.js";
import { OverlayRequestController } from "./overlay-controller.js";
import { SessionTransitionController } from "./session-transition.js";
import {
  moveStatusMessageToEnd,
  nextDisplayMessageKey,
  setUserInputStatus,
  snapshotDisplayParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
} from "../model/display-history.js";
import {
  accumulateLiveSubagentUpdate,
  pruneSettledLiveSubagentTools,
} from "../model/subagent-view.js";

export interface TuiExitSummary {
  reason: string;
  wallMs: number;
}

export interface BubbleTuiControllerDeps {
  readonly agent: Pick<Agent, "run" | "messages" | "setSessionID"> & { messages: DisplayMessage extends never ? never : unknown[] };
  readonly sessionManager: SessionManager;
  readonly ports: BubbleTuiPorts;
  readonly onEffect?: (effect: ControllerEffect) => void;
}

export class BubbleTuiController {
  private readonly state = new ControllerState();
  private readonly listeners = new Set<(version: number) => void>();
  private readonly overlays: OverlayRequestController;
  private readonly queue: InputQueueState = createInputQueueState();
  private readonly sessionTransition: SessionTransitionController;
  private readonly startedAtMs: number;
  private transcript: DisplayMessage[] = [];
  private runActive = false;
  private runState: RunState | null = null;
  /** Background subagent updates can outlive the provider turn that launched
   * them. Keep their latest synthetic tool snapshot in the live trace. */
  private readonly liveSubagentTools = new Map<string, DisplayToolCall>();
  private activeInputController: AgentRunInputQueue | null = null;
  private activeAbortController: AbortController | null = null;
  private readonly queuedAfterRun: Array<{ content: string; displayKey: string }> = [];
  /** False after a provider turn commits, so settled and live rows never coexist. */
  private liveStreamVisible = false;
  private disposed = false;

  constructor(private readonly deps: BubbleTuiControllerDeps) {
    this.overlays = new OverlayRequestController();
    this.startedAtMs = Date.now();
    this.sessionTransition = new SessionTransitionController({
      host: deps.ports.sessionHost,
      state: this.state,
      overlays: this.overlays,
      queue: this.queue,
      agent: {
        messages: deps.agent.messages as never,
        setSessionID: (file: string) => deps.agent.setSessionID(file),
      },
      bumpExternalGeneration: () => {
        this.externalGeneration += 1;
      },
      clearLiveSubagentTools: () => {
        this.liveSubagentTools.clear();
        this.liveSubagentVersion += 1;
      },
      commit: (notice?: string) => {
        this.publishTranscript(notice);
      },
    });
    this.overlays.onChange(() => this.state.touch());
  }

  private externalGeneration = 0;
  private liveSubagentVersion = 0;

  subscribe(listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshotVersion(): number {
    return this.state.version;
  }

  getTranscript(): readonly DisplayMessage[] {
    return this.transcript;
  }

  /** Drop every transcript row (/clear). */
  clearTranscript(): void {
    this.transcript = [];
    this.liveSubagentTools.clear();
    this.state.touch();
    this.notify();
  }

  /** Host-side row injection (user echo, notices) — single append point. */
  appendDisplayMessage(message: DisplayMessage): void {
    this.transcript = [...this.transcript, message];
    this.state.touch();
    this.notify();
  }

  isRunning(): boolean {
    return this.runActive;
  }

  pendingSteerCount(): number {
    return this.queue.pendingSteers.size;
  }

  queuedInputCount(): number {
    return this.queuedAfterRun.length;
  }

  /** Add input to the current Agent run without creating a second run that
   * would overwrite the shared streaming accumulator. */
  steer(content: string): boolean {
    if (!this.runActive || !this.activeInputController) return false;
    const input = this.activeInputController.enqueue(content);
    const displayKey = nextDisplayMessageKey("steer");
    beginSteer(this.queue, {
      id: input.id,
      content,
      displayKey,
      sessionFile: this.deps.sessionManager.getSessionFile(),
    });
    this.transcript = [...this.transcript, {
      key: displayKey,
      clientId: input.id,
      role: "user",
      content,
      inputStatus: "pending_steer",
    }];
    this.state.touch();
    this.notify();
    return true;
  }

  cancelActiveRun(reason = "Interrupted by user"): boolean {
    if (!this.activeAbortController || this.activeAbortController.signal.aborted) return false;
    this.activeAbortController.abort(Object.assign(new Error(reason), { name: "AgentAbortError" }));
    return true;
  }

  /**
   * Live streaming tail for the render loop: the in-flight accumulator's
   * content/reasoning/tool summary. Renderers draw it in the live region
   * (never committed to scrollback) until the turn commits.
   */
  getStreamingTail(): { content: string; reasoning: string; tools: DisplayToolCall[]; parts: DisplayMessagePart[]; phase: "thinking" | "working" } | null {
    if (!this.runActive || !this.runState || !this.liveStreamVisible) return null;
    const acc = this.runState.accumulator;
    const currentIds = new Set(acc.toolCalls.map((tool) => tool.id));
    const carriedTools = [...this.liveSubagentTools.values()].filter((tool) => !currentIds.has(tool.id));
    const allTools = [...acc.toolCalls, ...carriedTools];
    const parts = snapshotDisplayParts(acc.parts);
    if (carriedTools.length > 0) {
      parts.push({
        type: "tools",
        toolCalls: carriedTools.map((tool) => ({
          ...tool,
          args: { ...tool.args },
          metadata: tool.metadata ? { ...tool.metadata } : undefined,
        })),
      });
    }
    return {
      content: acc.content,
      // Ink kept the current provider turn's reasoning visible even after
      // answer/tool bytes arrived. Never hide it based on another live field.
      reasoning: acc.reasoning,
      // Return a render-safe snapshot: reducer events continue mutating the
      // accumulator in place while the TUI may still hold the previous tail.
      tools: allTools.map((tool) => ({
        ...tool,
        args: { ...tool.args },
        metadata: tool.metadata ? { ...tool.metadata } : undefined,
      })),
      // Parts are the canonical commentary/tool/commentary timeline. Without
      // them a live renderer necessarily moves every tool before all text.
      parts,
      // Phase is provider-turn local, matching Ink's clearAssistantStream().
      // A tool in an earlier committed turn must not suppress fresh Thinking.
      phase: allTools.length > 0 ? "working" : "thinking",
    };
  }

  pendingOverlayCount(): number {
    return this.overlays.pendingCount();
  }

  /**
   * Drive one agent run: reduce the event stream, apply effects, and finish.
   * Mirrors runAgentInput (app.tsx:1438-1958) minus the rendering.
   */
  async runTurn(input: unknown, cwd: string, options?: AgentRunOptions): Promise<void> {
    if (this.disposed) throw new Error("controller disposed");
    if (this.runActive) {
      if (typeof input === "string") this.steer(input);
      return;
    }
    this.runActive = true;
    this.liveStreamVisible = true;
    this.runState = createRunState(Date.now());
    const inputController = new AgentRunInputQueue(`run-${this.runState.accumulator.runId}`);
    const abortController = new AbortController();
    this.activeInputController = inputController;
    this.activeAbortController = abortController;
    const upstreamAbort = () => abortController.abort(options?.abortSignal?.reason);
    if (options?.abortSignal?.aborted) upstreamAbort();
    else options?.abortSignal?.addEventListener("abort", upstreamAbort, { once: true });
    pruneSettledLiveSubagentTools(this.liveSubagentTools);
    this.state.touch();
    this.notify();

    const ctx: RunContext = {
      external: false,
      isCurrentRun: () => !this.disposed,
      now: () => this.deps.ports.clock.now(),
      runStartedAt: this.deps.ports.clock.now(),
      pendingSteers: this.queue.pendingSteers,
    };

    let runError: unknown;
    let cancelled = false;
    try {
      for await (const event of this.deps.agent.run(input as never, cwd, {
        ...options,
        abortSignal: abortController.signal,
        inputController,
      })) {
        const { state, effects } = reduceAgentEvent(this.runState!, event, ctx);
        this.runState = state;

        if (
          event.type === "tool_update"
          && effects.some((effect) => effect.kind === "live-subagent-changed")
        ) {
          accumulateLiveSubagentUpdate(this.liveSubagentTools, {
            id: event.id,
            name: event.name,
            metadata: event.update.metadata,
          });
        }
        if (event.type === "input_rejected") {
          const steer = this.queue.pendingSteers.get(event.id);
          if (steer) {
            this.queue.pendingSteers.delete(event.id);
            this.queuedAfterRun.push({ content: event.content, displayKey: steer.displayKey });
            this.transcript = this.transcript.map((message) => (
              message.key === steer.displayKey ? setUserInputStatus(message, "queued") : message
            ));
          }
        } else if (event.type === "input_applied") {
          this.queue.pendingSteers.delete(event.id);
        }

        // Visibility is an event-boundary concern, not a generic consequence
        // of clearing the accumulator. A provider turn_start/retry must keep
        // the empty waiting spinner mounted; only turn_end hides the live tail
        // in the same transaction that commits its settled replacement.
        if (event.type === "turn_end") {
          this.liveStreamVisible = !!event.willContinue;
        } else if (
          event.type === "turn_start"
          || event.type === "text_delta"
          || event.type === "reasoning_delta"
          || event.type === "tool_call_start"
          || event.type === "tool_start"
        ) {
          this.liveStreamVisible = true;
        }
        if (event.type === "turn_end") {
          // Commit the provider turn and replace its accumulator in the same
          // observable frame. For a continuation, keep an empty waiting tail;
          // for a final boundary, keep it hidden. Clearing the accumulator at
          // BOTH boundaries is important: Agent still performs cleanup after
          // final turn_end, and an error there must not commit the settled
          // answer a second time from the stale accumulator.
          this.state.withTransaction(() => {
            for (const effect of effects) this.applyEffectMutation(effect);
            this.runState = createRunState(this.runState?.accumulator.runId ?? Date.now());
            this.liveStreamVisible = !!event.willContinue;
            this.state.touch();
          });
          this.notify();
        } else {
          this.applyEffects(effects);
        }

        const hasDirty = Object.values(this.runState.dirty).some(Boolean);
        // Text/reasoning deltas have no immediate effect notification. Batch
        // them behind one coalesced 40ms paint. Tool events already notified
        // through their effects, so acknowledging their dirty bits here avoids
        // a redundant delayed repaint. Dirty means "paint pending", not
        // "this run has ever changed", and must never remain latched forever.
        if (hasDirty && (event.type === "text_delta" || event.type === "reasoning_delta")) {
          this.deps.ports.flush.scheduleFlush(STREAMING_FLUSH_INTERVAL_MS, () => {
            if (this.disposed || !this.runActive) return;
            this.state.touch();
            this.notify();
          });
        }
        if (hasDirty) {
          this.runState = {
            ...this.runState,
            dirty: { content: false, reasoning: false, parts: false, tools: false },
          };
        }
      }
    } catch (error) {
      runError = error;
      cancelled = this.isAbortLike(error);
      // Legacy catch (app.tsx:1855-1861): commit the partial answer before
      // surfacing the interrupt/error so streamed content is not lost.
      const partial = this.runState ? buildAssistantMessage(this.runState) : null;
      // The partial commit, error effect, and live-tail removal are one frame.
      // Publishing the partial first used to expose {settled, live:true}, then
      // finally removed the tail in a second frame (visible duplication).
      this.state.withTransaction(() => {
        if (partial) this.transcript = [...this.transcript, partial];
        this.liveStreamVisible = false;
        this.applyEffectMutation({ kind: "run-error", error });
        this.state.touch();
      });
      this.notify();
    } finally {
      const leftoverSteers = inputController.clear();
      // The signal is the source of truth. A provider may observe cancellation
      // and end its iterator without throwing, but the user's pending steers
      // must still be dropped exactly as they are in the Ink implementation.
      cancelled ||= abortController.signal.aborted;
      for (const leftover of leftoverSteers) {
        const steer = this.queue.pendingSteers.get(leftover.id);
        if (!steer) continue;
        this.queue.pendingSteers.delete(leftover.id);
        if (cancelled) {
          this.transcript = this.transcript.filter((message) => message.key !== steer.displayKey);
        } else {
          this.queuedAfterRun.push({ content: leftover.content, displayKey: steer.displayKey });
          this.transcript = this.transcript.map((message) => (
            message.key === steer.displayKey ? setUserInputStatus(message, "queued") : message
          ));
        }
      }
      const finish = reduceRunFinish(this.runState ?? createRunState(0), {
        cancelled,
        errored: runError != null && !cancelled,
        // Leftovers were already applied above while their display metadata
        // was still available. Do not ask the reducer to emit a second drain.
        leftoverSteers: [],
        ownsCurrentGeneration: true,
      });
      this.state.withTransaction(() => {
        for (const effect of finish.effects) this.applyEffectMutation(effect);
        this.deps.ports.flush.cancelFlush();
        this.runActive = false;
        this.liveStreamVisible = false;
        this.runState = null;
        this.activeInputController = null;
        this.activeAbortController = null;
        this.state.touch();
      });
      this.notify();
      options?.abortSignal?.removeEventListener("abort", upstreamAbort);
    }

    const next = this.queuedAfterRun.shift();
    if (next && !this.disposed) {
      this.transcript = moveStatusMessageToEnd(this.transcript, next.displayKey);
      this.state.touch();
      this.notify();
      await this.runTurn(next.content, cwd, options);
    }
  }

  /** Apply one reducer transition and publish exactly one observable snapshot. */
  private applyEffects(effects: readonly ControllerEffect[]): void {
    if (effects.length === 0) return;
    this.state.withTransaction(() => {
      for (const effect of effects) this.applyEffectMutation(effect);
    });
    this.notify();
  }

  /** Mutate for one effect; callers own the surrounding transaction + notify. */
  private applyEffectMutation(effect: ControllerEffect): void {
    this.deps.onEffect?.(effect);
    switch (effect.kind) {
      case "stream-cleared":
        this.deps.ports.flush.cancelFlush();
        break;
      case "assistant-committed": {
        const message = this.runState ? buildAssistantMessage(this.runState, effect.taskElapsedMs) : null;
        if (message) this.transcript = [...this.transcript, message];
        break;
      }
      case "transcript-append":
        this.transcript = [...this.transcript, effect.message];
        break;
      case "notice":
        this.transcript = [...this.transcript, { key: `notice-${this.transcript.length}`, role: effect.role === "error" ? "error" : "assistant", content: effect.text }];
        break;
      case "queue-updated":
        void effect.pending;
        break;
      case "steer-applied":
        this.transcript = moveStatusMessageToEnd(this.transcript, effect.displayKey);
        break;
      case "steer-requeued":
        // The event loop records the rejected content and queued badge.
        break;
      case "run-error": {
        const message = effect.error instanceof Error ? effect.error.message : String(effect.error);
        if (this.isAbortLike(effect.error)) {
          this.transcript = [...this.transcript, {
            key: nextDisplayMessageKey("interrupt"),
            role: "assistant",
            content: message || "Interrupted by user",
            syntheticKind: "ui_interrupt",
          }];
        } else {
          this.transcript = [...this.transcript, {
            key: nextDisplayMessageKey("error"),
            role: "error",
            content: message || "Agent run failed",
          }];
        }
        break;
      }
      default:
        break;
    }
    this.state.touch();
  }

  private publishTranscript(notice?: string): void {
    purgeForSessionSwitch(this.queue);
    if (notice) {
      this.transcript = [...this.transcript, { key: `notice-${this.transcript.length}`, role: "assistant", content: notice }];
    }
    this.state.touch();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state.version);
  }

  private isAbortLike(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "AgentAbortError");
  }

  /** Drain leftover steers at run end (cancelled drops, normal requeues). */
  drainLeftovers(leftovers: Array<{ id: string; content: string }>, cancelled: boolean): void {
    drainLeftoverSteers(this.queue, leftovers, { cancelled });
    this.state.touch();
  }

  /** Atomic session switch through the two-phase transaction. */
  switchSession(plan: { targetFile: string; notice?: string }): { ok: boolean; error?: string } {
    const outcome = this.sessionTransition.switchTo(plan);
    if (outcome.ok) {
      // A next-turn input belongs to the session in which it was submitted.
      // The extracted session transition owns its queue, while queuedAfterRun
      // is the controller's executable mirror and must be purged alongside it.
      this.queuedAfterRun.length = 0;
      this.notify();
    }
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
  }

  /**
   * Shutdown: settle overlays, cancel any run, and report the exit summary.
   * Idempotent — a second call is a no-op.
   */
  shutdown(reason: string): TuiExitSummary {
    if (this.disposed) {
      return { reason, wallMs: Date.now() - this.startedAtMs };
    }
    this.disposed = true;
    this.cancelActiveRun(reason);
    this.overlays.dispose();
    this.deps.ports.flush.cancelFlush();
    return { reason, wallMs: Date.now() - this.startedAtMs };
  }
}

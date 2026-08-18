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
  type RunContext,
  type RunState,
} from "./agent-event-reducer.js";
import {
  createInputQueueState,
  drainLeftoverSteers,
  purgeForSessionSwitch,
  type InputQueueState,
} from "./input-queue-machine.js";
import { OverlayRequestController } from "./overlay-controller.js";
import { SessionTransitionController } from "./session-transition.js";
import type { DisplayMessage } from "../model/display-history.js";

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

  pendingOverlayCount(): number {
    return this.overlays.pendingCount();
  }

  /**
   * Drive one agent run: reduce the event stream, apply effects, and finish.
   * Mirrors runAgentInput (app.tsx:1438-1958) minus the rendering.
   */
  async runTurn(input: unknown, cwd: string, options?: AgentRunOptions): Promise<void> {
    if (this.disposed) throw new Error("controller disposed");
    this.runActive = true;
    this.runState = createRunState(Date.now());
    this.state.touch();

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
      for await (const event of this.deps.agent.run(input as never, cwd, options)) {
        const { state, effects } = reduceAgentEvent(this.runState!, event, ctx);
        this.runState = state;
        for (const effect of effects) this.applyEffect(effect);
      }
    } catch (error) {
      runError = error;
      cancelled = this.isAbortLike(error);
      // Legacy catch (app.tsx:1855-1861): commit the partial answer before
      // surfacing the interrupt/error so streamed content is not lost.
      const partial = this.runState ? buildAssistantMessage(this.runState) : null;
      if (partial) this.transcript = [...this.transcript, partial];
      this.applyEffect({ kind: "run-error", error });
    } finally {
      const finish = reduceRunFinish(this.runState ?? createRunState(0), {
        cancelled,
        errored: runError != null,
        leftoverSteers: [],
        ownsCurrentGeneration: true,
      });
      for (const effect of finish.effects) this.applyEffect(effect);
      this.deps.ports.flush.cancelFlush();
      this.runActive = false;
      this.runState = null;
      this.state.touch();
    }
  }

  /** Apply one effect against controller state (host observes via onEffect). */
  private applyEffect(effect: ControllerEffect): void {
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
      default:
        break;
    }
    this.state.touch();
    this.notify();
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
    if (outcome.ok) this.notify();
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
    this.overlays.dispose();
    this.deps.ports.flush.cancelFlush();
    return { reason, wallMs: Date.now() - this.startedAtMs };
  }
}

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
import type { WorkflowRunSnapshot } from "../../agent/workflow/control.js";
import type { BackgroundTaskInfo } from "../../tasks/manager.js";
import type { SessionManager } from "../../session.js";
import type { GoalStore } from "../../goal/store.js";
import { tokenUsageTotal } from "../../goal/usage.js";
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
  collectSubagentGroups,
  mergeSubagentSnapshotsIntoMessages,
  pruneSettledLiveSubagentTools,
  type SubagentGroup,
} from "../model/subagent-view.js";
import { reconstructDisplayMessages } from "../model/display-reconstruct.js";
import type { SubmitPayload } from "../model/composer-types.js";
import { buildImageContentParts, buildImageContentPartsFromDisplayText } from "../model/image-paste.js";
import { displayImagesFromPayload, formatImageUserDisplayText } from "../image-display.js";
import { GoalRuntimeController } from "./goal-runtime-controller.js";
import { executeRewind, type RewindExecutionResult, type RewindScope } from "../../rewind.js";
import type { ContentPart, Message } from "../../types.js";

export interface TuiExitSummary {
  reason: string;
  wallMs: number;
}

export interface BubbleTuiControllerDeps {
  readonly agent: Pick<Agent,
    | "run"
    | "messages"
    | "setSessionID"
    | "listSubAgents"
    | "listWorkflows"
    | "getSubAgentMessages"
    | "closeSubAgent"
    | "closeWorkflow"
    | "resetContextUsageAnchor"
  > & {
    messages: Message[];
    backgroundTasks?: Agent["backgroundTasks"];
  };
  readonly sessionManager: SessionManager;
  readonly goalStore?: GoalStore;
  readonly ports: BubbleTuiPorts;
  readonly onEffect?: (effect: ControllerEffect) => void;
}

export interface TuiAgentRunOptions extends AgentRunOptions {
  /** Internal Goal continuation; never forwarded to Agent.run(). */
  goalRun?: boolean;
}

export interface CommandActivity {
  kind: "compact";
  status: "running" | "cancelling";
  startedAt: number;
}

function isSubmitPayload(value: unknown): value is SubmitPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<SubmitPayload>;
  return typeof payload.text === "string" && Array.isArray(payload.images);
}

export class BubbleTuiController {
  private readonly state = new ControllerState();
  private readonly listeners = new Set<(version: number) => void>();
  private readonly overlays: OverlayRequestController;
  private readonly queue: InputQueueState = createInputQueueState();
  private readonly sessionTransition: SessionTransitionController;
  private readonly startedAtMs: number;
  private readonly goalRuntime?: GoalRuntimeController;
  private sessionManager: SessionManager;
  private transcript: DisplayMessage[] = [];
  private runActive = false;
  private runState: RunState | null = null;
  /** Background subagent updates can outlive the provider turn that launched
   * them. Keep their latest synthetic tool snapshot in the live trace. */
  private readonly liveSubagentTools = new Map<string, DisplayToolCall>();
  /** Provider-turn accumulators for true child-session inspection. */
  private readonly childRuns = new Map<string, { state: RunState; visible: boolean; updatedAt: number }>();
  private activeInputController: AgentRunInputQueue | null = null;
  private activeAbortController: AbortController | null = null;
  private commandActivity: (CommandActivity & { abortController: AbortController }) | null = null;
  /** False after a provider turn commits, so settled and live rows never coexist. */
  private liveStreamVisible = false;
  private readonly backgroundTaskUnsubscribe?: () => void;
  private disposed = false;

  constructor(private readonly deps: BubbleTuiControllerDeps) {
    this.sessionManager = deps.sessionManager;
    this.overlays = new OverlayRequestController();
    this.startedAtMs = Date.now();
    this.sessionTransition = new SessionTransitionController({
      host: deps.ports.sessionHost,
      state: this.state,
      overlays: this.overlays,
      queue: this.queue,
      agent: {
        getMessages: () => deps.agent.messages,
        setSessionID: (file: string) => deps.agent.setSessionID(file),
      },
      bumpExternalGeneration: () => {
        this.externalGeneration += 1;
      },
      clearLiveSubagentTools: () => {
        this.liveSubagentTools.clear();
        this.childRuns.clear();
        this.liveSubagentVersion += 1;
      },
      commit: (manager, transcript) => {
        this.sessionManager = manager;
        this.deps.ports.flush.cancelFlush();
        this.transcript = transcript;
        this.queue.queued.length = 0;
        this.liveStreamVisible = false;
        this.runState = null;
        this.activeInputController = null;
        this.activeAbortController = null;
        this.commandActivity = null;
        this.state.touch();
      },
    });
    this.overlays.onChange(() => this.state.touch());
    if (deps.goalStore) {
      this.goalRuntime = new GoalRuntimeController({
        store: deps.goalStore,
        getSessionManager: () => this.sessionManager,
        isRunActive: () => this.isBusy(),
        queuedInputs: () => this.queue.queued.length,
        isDisposed: () => this.disposed,
        startRun: (input, cwd) => {
          void this.runTurn(input, cwd, { goalRun: true });
        },
        appendMessage: (role, content) => {
          this.appendDisplayMessage({
            key: nextDisplayMessageKey(role === "user" ? "user" : role === "error" ? "error" : "notice"),
            role,
            content,
            syntheticKind: role === "assistant" ? "ui_notice" : undefined,
          });
        },
        onStateChanged: () => {
          this.state.touch();
          this.notify();
        },
      });
    }
    this.backgroundTaskUnsubscribe = deps.agent.backgroundTasks?.subscribe?.(() => {
      this.state.touch();
      this.notify();
    });
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

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getGoalIndicator(): string | undefined {
    return this.goalRuntime?.indicatorLine();
  }

  handleGoalCommand(input: string, cwd: string): void {
    if (!this.goalRuntime) {
      this.appendDisplayMessage({
        key: nextDisplayMessageKey("error"),
        role: "error",
        content: "Goals are not available in this session.",
      });
      return;
    }
    this.goalRuntime.handleCommand(input, cwd);
  }

  getSubagentGroups(): SubagentGroup[] {
    const fromTrace = collectSubagentGroups(this.transcript, [...this.liveSubagentTools.values()]);
    const claimed = new Set(fromTrace.flatMap((group) => group.members.map((member) => member.subAgentId).filter(Boolean)));
    const direct = this.deps.agent.listSubAgents()
      .filter((snapshot) => !claimed.has(snapshot.agentId))
      .map((snapshot): SubagentGroup => ({
        id: `single:${snapshot.agentId}`,
        runId: snapshot.runId,
        kind: "single",
        label: snapshot.nickname,
        members: [{
          subAgentId: snapshot.agentId,
          agentName: snapshot.agentName,
          nickname: snapshot.nickname,
          status: snapshot.status,
          category: snapshot.category,
          phase: snapshot.phase,
          route: snapshot.route,
          profileSource: snapshot.profileSource,
          task: snapshot.task,
          summary: snapshot.summary,
          toolNotes: snapshot.toolNotes,
          error: snapshot.error,
          usage: snapshot.usage,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
        }],
      }));
    return [...fromTrace, ...direct];
  }

  getWorkflows(): WorkflowRunSnapshot[] {
    return this.deps.agent.listWorkflows();
  }

  getBackgroundTasks(): BackgroundTaskInfo[] {
    return this.deps.agent.backgroundTasks?.list() ?? [];
  }

  getChildTranscript(agentId: string): DisplayMessage[] {
    return reconstructDisplayMessages(this.deps.agent.getSubAgentMessages(agentId));
  }

  getChildStreamingTail(agentId: string): { content: string; reasoning: string; tools: DisplayToolCall[]; parts: DisplayMessagePart[] } | null {
    const child = this.childRuns.get(agentId);
    if (!child?.visible) return null;
    const acc = child.state.accumulator;
    return {
      content: acc.content,
      reasoning: acc.reasoning,
      tools: acc.toolCalls.map((tool) => ({
        ...tool,
        args: { ...tool.args },
        metadata: tool.metadata ? { ...tool.metadata } : undefined,
      })),
      parts: snapshotDisplayParts(acc.parts),
    };
  }

  stopSubagent(agentId: string): void {
    void this.deps.agent.closeSubAgent(agentId);
  }

  stopWorkflow(runId: string): void {
    this.deps.agent.closeWorkflow(runId);
  }

  stopBackgroundTask(id: string): void {
    void this.deps.agent.backgroundTasks?.kill?.(id);
  }

  getBackgroundTaskOutput(id: string): string {
    return this.deps.agent.backgroundTasks?.outputTail(id) ?? "";
  }

  /** Drop every transcript row (/clear). */
  clearTranscript(): void {
    this.transcript = [];
    this.liveSubagentTools.clear();
    this.childRuns.clear();
    this.state.touch();
    this.notify();
  }

  /** Re-project the visible transcript after a non-controller command rewrites Agent history. */
  rebuildTranscriptFromAgent(): void {
    this.state.withTransaction(() => {
      this.transcript = reconstructDisplayMessages([...this.deps.agent.messages]);
      this.liveSubagentTools.clear();
      this.childRuns.clear();
      this.liveSubagentVersion += 1;
      this.state.touch();
    });
    this.notify();
  }

  /**
   * Rewind persistence and every renderer-facing mirror as one observable
   * transition. File restoration can take time, but no partial transcript is
   * published while it runs.
   */
  async rewindToTurn(targetId: string, scope: RewindScope): Promise<RewindExecutionResult> {
    if (this.runActive) throw new Error("Cancel the active turn before rewinding.");
    const result = await executeRewind(this.sessionManager, this.deps.agent, targetId, scope);
    if (scope !== "code") {
      this.state.withTransaction(() => {
        purgeForSessionSwitch(this.queue);
        this.queue.queued.length = 0;
        this.transcript = reconstructDisplayMessages([...this.deps.agent.messages]);
        this.liveSubagentTools.clear();
        this.childRuns.clear();
        this.liveSubagentVersion += 1;
        this.liveStreamVisible = false;
        this.runState = null;
        this.state.touch();
      });
      this.notify();
    }
    return result;
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

  /** A slash command that owns the activity lane without masquerading as an
   * Agent turn. This keeps streaming/steering state separate while still
   * giving Escape and Ctrl+C one cancellation boundary. */
  beginCommandActivity(kind: CommandActivity["kind"]): AbortSignal {
    if (this.runActive || this.commandActivity) {
      throw new Error("Another operation is already running.");
    }
    const abortController = new AbortController();
    this.commandActivity = {
      kind,
      status: "running",
      startedAt: this.deps.ports.clock.now(),
      abortController,
    };
    this.state.touch();
    this.notify();
    return abortController.signal;
  }

  finishCommandActivity(kind: CommandActivity["kind"], event?: DisplayMessage): void {
    if (this.commandActivity?.kind !== kind) return;
    this.state.withTransaction(() => {
      if (event) this.transcript = [...this.transcript, event];
      this.commandActivity = null;
      this.state.touch();
    });
    this.notify();
  }

  getCommandActivity(): CommandActivity | null {
    const activity = this.commandActivity;
    if (!activity) return null;
    return {
      kind: activity.kind,
      status: activity.status,
      startedAt: activity.startedAt,
    };
  }

  isBusy(): boolean {
    return this.runActive || this.commandActivity !== null;
  }

  /** Queue composer input while a command owns the pane. Grok keeps the
   * composer available during Compact; the message starts after the command
   * reaches its terminal event instead of racing the history rewrite. */
  queueAfterCommand(input: string | SubmitPayload): boolean {
    if (!this.commandActivity) return false;
    this.queueInput(input);
    return true;
  }

  /** Queue a complete composer payload for the next provider turn. */
  queueInput(input: string | SubmitPayload): void {
    const payload = typeof input === "string" ? { text: input, images: [] } : input;
    const displayKey = nextDisplayMessageKey("queued");
    this.queue.queued.push({
      payload,
      displayKey,
      sessionFile: this.sessionManager.getSessionFile(),
    });
    this.transcript = [...this.transcript, {
      key: displayKey,
      role: "user",
      content: this.submitDisplayText(payload),
      images: displayImagesFromPayload(payload),
      inputStatus: "queued",
    }];
    this.state.touch();
    this.notify();
  }

  async drainQueuedInputs(cwd: string, agentOptions: AgentRunOptions = {}): Promise<void> {
    if (this.isBusy()) return;
    const next = this.queue.queued.shift();
    if (!next || this.disposed) return;
    if (next.displayKey) {
      this.transcript = moveStatusMessageToEnd(this.transcript, next.displayKey);
    }
    this.state.touch();
    this.notify();
    await this.runTurn(next.payload, cwd, agentOptions);
  }

  pendingSteerCount(): number {
    return this.queue.pendingSteers.size;
  }

  queuedInputCount(): number {
    return this.queue.queued.length;
  }

  private submitDisplayText(payload: SubmitPayload): string {
    return formatImageUserDisplayText(
      payload.displayText ?? payload.text,
      payload.images.length,
      payload.imageDisplayStart,
    );
  }

  private submitAgentInput(payload: SubmitPayload): string | ContentPart[] {
    if (payload.images.length === 0) return payload.text;
    return payload.displayText
      ? buildImageContentPartsFromDisplayText(
          payload.displayText,
          payload.text,
          payload.images,
          payload.imageDisplayStart,
        )
      : buildImageContentParts(payload.text, payload.images);
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
      sessionFile: this.sessionManager.getSessionFile(),
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
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort(Object.assign(new Error(reason), { name: "AgentAbortError" }));
      return true;
    }
    if (this.commandActivity && !this.commandActivity.abortController.signal.aborted) {
      this.commandActivity.status = "cancelling";
      this.commandActivity.abortController.abort(Object.assign(new Error(reason), { name: "AgentAbortError" }));
      this.state.touch();
      this.notify();
      return true;
    }
    return false;
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
  async runTurn(input: unknown, cwd: string, options?: TuiAgentRunOptions): Promise<void> {
    if (this.disposed) throw new Error("controller disposed");
    if (this.commandActivity) {
      throw new Error("A command is already running.");
    }
    if (this.runActive) {
      if (typeof input === "string") this.steer(input);
      else if (isSubmitPayload(input)) {
        if (input.images.length === 0) this.steer(input.text);
        else this.queueInput(input);
      }
      return;
    }
    const agentInput = isSubmitPayload(input) ? this.submitAgentInput(input) : input;
    this.runActive = true;
    this.liveStreamVisible = true;
    this.runState = createRunState(Date.now());
    const inputController = new AgentRunInputQueue(`run-${this.runState.accumulator.runId}`);
    const abortController = new AbortController();
    const goalStatusAtStart = this.goalRuntime?.snapshot()?.status;
    const goalRun = options?.goalRun === true;
    const agentOptions: AgentRunOptions = { ...options };
    delete (agentOptions as TuiAgentRunOptions).goalRun;
    if (isSubmitPayload(input) && input.images.length > 0 && input.displayText) {
      agentOptions.userMessageUi = {
        displayText: input.displayText,
        ...(input.imageDisplayStart !== undefined
          ? { imageDisplayStart: input.imageDisplayStart }
          : {}),
      };
    }
    let runUsageTokens = 0;
    let runUsageReported = false;
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
      for await (const event of this.deps.agent.run(agentInput as never, cwd, {
        ...agentOptions,
        abortSignal: abortController.signal,
        inputController,
      })) {
        if (event.type === "turn_end" && event.usage) {
          runUsageReported = true;
          runUsageTokens += tokenUsageTotal(event.usage);
        }
        const { state, effects } = reduceAgentEvent(this.runState!, event, ctx);
        this.runState = state;

        const subagentMetadata = event.type === "tool_update"
          ? event.update.metadata
          : event.type === "tool_end"
            ? event.result.metadata
            : undefined;
        if (subagentMetadata?.kind === "subagent") {
          this.transcript = mergeSubagentSnapshotsIntoMessages(this.transcript, subagentMetadata);
        }

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
        if (event.type === "tool_update" && event.update.childEvent) {
          this.reduceChildEvent(event.update.subAgentId, event.update.childEvent);
        }
        if (event.type === "input_rejected") {
          const steer = this.queue.pendingSteers.get(event.id);
          if (steer) {
            this.queue.pendingSteers.delete(event.id);
            this.queue.queued.push({
              payload: { text: event.content, images: [] },
              displayKey: steer.displayKey,
              sessionFile: steer.sessionFile ?? this.sessionManager.getSessionFile(),
            });
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
          this.queue.queued.push({
            payload: { text: leftover.content, images: [] },
            displayKey: steer.displayKey,
            sessionFile: steer.sessionFile ?? this.sessionManager.getSessionFile(),
          });
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

    this.goalRuntime?.afterRun({
      goalRun,
      goalStatusAtStart,
      cancelled,
      errored: runError != null && !cancelled,
      usageTokens: runUsageTokens,
      usageReported: runUsageReported,
    }, cwd);

    await this.drainQueuedInputs(cwd, agentOptions);
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
        this.transcript = [...this.transcript, {
          key: `notice-${this.transcript.length}`,
          role: effect.role === "error" ? "error" : "assistant",
          content: effect.text,
          syntheticKind: effect.role === "error" ? undefined : "ui_notice",
        }];
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

  private notify(): void {
    for (const listener of this.listeners) listener(this.state.version);
  }

  private reduceChildEvent(agentId: string, event: import("../../types.js").AgentEvent): void {
    const current = this.childRuns.get(agentId) ?? {
      state: createRunState(Date.now()),
      visible: true,
      updatedAt: Date.now(),
    };
    const reduced = reduceAgentEvent(current.state, event, {
      external: false,
      isCurrentRun: () => !this.disposed,
      now: () => this.deps.ports.clock.now(),
      runStartedAt: current.state.accumulator.runId,
      pendingSteers: new Map(),
    });
    let state = reduced.state;
    let visible = current.visible;
    if (event.type === "turn_start") visible = true;
    if (event.type === "turn_end") {
      state = createRunState(current.state.accumulator.runId);
      visible = !!event.willContinue;
    }
    this.childRuns.set(agentId, { state, visible, updatedAt: Date.now() });
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
    if (this.isBusy()) return { ok: false, error: "Stop the current run before switching sessions." };
    const outcome = this.sessionTransition.switchTo(plan);
    if (outcome.ok && outcome.manager) {
      this.goalRuntime?.loadCurrentSession();
      this.notify();
    }
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
  }

  /** Start an empty native session using the same atomic lifecycle as resume. */
  createFreshSession(cwd: string, notice?: string): { ok: boolean; error?: string } {
    if (this.isBusy()) return { ok: false, error: "Stop the current run before starting a new session." };
    const outcome = this.sessionTransition.createFresh(cwd, notice);
    if (outcome.ok && outcome.manager) {
      this.goalRuntime?.loadCurrentSession();
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
    this.goalRuntime?.dispose();
    this.overlays.dispose();
    this.backgroundTaskUnsubscribe?.();
    this.deps.ports.flush.cancelFlush();
    return { reason, wallMs: Date.now() - this.startedAtMs };
  }
}

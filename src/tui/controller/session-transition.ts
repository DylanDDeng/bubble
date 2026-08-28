/**
 * Session switch as a two-phase transaction (controller extraction §4).
 *
 * prepare (host-owned, may fail): the switchSession/createFresh closures in
 * main.ts:711-759 — disk IO, history reload, agent rebinding.
 * commit (controller-owned, atomic): the applySessionSwitch cleanup list
 * (app.tsx:986-1018), executed inside one transaction so subscribers see
 * exactly two snapshots (before, after) — never a mixed-session state.
 */
import type { SessionManager } from "../../session.js";
import { queuedAndPendingDisplayKeys } from "../model/input-queue.js";
import type { InputQueueState } from "./input-queue-machine.js";
import type { OverlayRequestController } from "./overlay-controller.js";
import type { ControllerState } from "./state.js";
import type { SessionHostPort } from "./ports.js";
import { reconstructDisplayMessages } from "../model/display-reconstruct.js";
import { nextDisplayMessageKey, type DisplayMessage } from "../model/display-history.js";

export interface SessionTransitionPlan {
  targetFile: string;
  notice?: string;
}

export interface SwitchOutcome {
  ok: boolean;
  manager?: SessionManager;
  error?: string;
}

export interface SessionTransitionDeps {
  host: SessionHostPort;
  state: ControllerState;
  overlays: OverlayRequestController;
  queue: InputQueueState;
  agent: { getMessages(): readonly import("../../types.js").Message[]; setSessionID(file: string): void };
  /** Bump to invalidate stale external-runtime events. */
  bumpExternalGeneration(): void;
  clearLiveSubagentTools(): void;
  /** Apply every controller-owned mirror inside the atomic commit. */
  commit(manager: SessionManager, transcript: DisplayMessage[]): void;
}

export class SessionTransitionController {
  constructor(private readonly deps: SessionTransitionDeps) {}

  /**
   * Full switch: host prepare, then atomic commit. On prepare failure the
   * previous session is untouched and no notification fires.
   */
  switchTo(plan: SessionTransitionPlan): SwitchOutcome {
    const result = this.deps.host.switchSession(plan.targetFile);
    if ("error" in result) {
      return { ok: false, error: result.error };
    }
    this.commitSwitch(result.manager, plan.notice);
    return { ok: true, manager: result.manager };
  }

  /** Create and enter a new empty session through the same transaction. */
  createFresh(cwd: string, notice?: string): SwitchOutcome {
    const result = this.deps.host.createFresh(cwd);
    if ("error" in result) {
      return { ok: false, error: result.error };
    }
    this.commitSwitch(result.manager, notice);
    return { ok: true, manager: result.manager };
  }

  /** Atomic commit — the twelve-item cleanup list from the design doc §4.2. */
  private commitSwitch(manager: SessionManager, notice?: string): void {
    // Snapshot the keys to filter BEFORE purging (the queue is part of state).
    const queuedDisplayKeys = queuedAndPendingDisplayKeys(
      this.deps.queue.queued,
      this.deps.queue.pendingSteers.values(),
    );
    const transcript = this.buildTranscript(notice, queuedDisplayKeys);

    this.deps.state.withTransaction(() => {
      // 1. Invalidate late external-runtime events.
      this.deps.bumpExternalGeneration();
      // 3. Purge queue/steer state.
      this.deps.queue.queued.length = 0;
      this.deps.queue.pendingSteers.clear();
      // 6. Rebind the session and the agent's session id.
      this.deps.agent.setSessionID(manager.getSessionFile());
      // 7. External binding refresh comes from the new manager's metadata.
      void manager.getMetadata().externalRuntime;
      // 8. Drop live subagent accumulators (ghost-group defense).
      this.deps.clearLiveSubagentTools();
      // 11. Settle every blocking request (behavior delta vs legacy).
      this.deps.overlays.settleAll("session-switch");
      // 9. Replace the entire renderer-facing history. The host has already
      // rebound Agent.messages, so this projects the NEW session rather than
      // appending a notice to the previous session's transcript.
      this.deps.commit(manager, transcript);
    });
  }

  /** Rebuild the transcript rows for a freshly committed session. */
  buildTranscript(notice?: string, queuedDisplayKeys?: Set<string>): DisplayMessage[] {
    const rows = reconstructDisplayMessages([...this.deps.agent.getMessages()])
      .filter((message) => !queuedDisplayKeys?.has(message.key ?? ""));
    return notice
      ? [...rows, {
          key: nextDisplayMessageKey("notice"),
          role: "assistant" as const,
          content: notice,
          syntheticKind: "ui_notice" as const,
        }]
      : rows;
  }
}

import { AgentAbortError, throwIfAborted } from "../agent/abort-errors.js";

export type SessionTurnPhase =
  | "queued"
  | "reserved"
  | "starting"
  | "active"
  | "stopping"
  | "settled";

export interface SessionTurnQueueState {
  active: boolean;
  queued: number;
  phase: Exclude<SessionTurnPhase, "queued" | "settled"> | "idle" | "deleted";
}

export interface SessionTurnReservation {
  readonly id: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly phase: SessionTurnPhase;
  readonly completion: Promise<void>;
  waitForStart(): Promise<void>;
  markActive(): void;
  cancel(error?: Error): void;
  finish(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface TurnRecord {
  id: string;
  sessionId: string;
  phase: SessionTurnPhase;
  abort: AbortController;
  start: Deferred<void>;
  completion: Deferred<void>;
  externalSignal?: AbortSignal;
  onExternalAbort?: () => void;
  terminalError?: Error;
}

interface SessionRecord {
  current?: TurnRecord;
  queued: TurnRecord[];
}

/**
 * One synchronous state machine owns the complete per-session turn lifecycle.
 * A reservation and its AbortController are created when runTurn() is called,
 * before its async iterator is consumed, so stop/delete never have a handoff
 * window in which a turn is invisible.
 */
export class SessionTurnCoordinator {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly deletedSessions = new Set<string>();
  private nextTurnId = 0;

  reserve(sessionId: string, signal?: AbortSignal): SessionTurnReservation {
    if (this.deletedSessions.has(sessionId)) {
      throw new Error(`Session is deleted: ${sessionId}`);
    }
    throwIfAborted(signal);

    const turn: TurnRecord = {
      id: `sdk-turn-${++this.nextTurnId}`,
      sessionId,
      phase: "queued",
      abort: new AbortController(),
      start: deferred<void>(),
      completion: deferred<void>(),
      externalSignal: signal,
    };
    // A reservation can legally be stopped before its iterator is consumed.
    // Keep that rejected start promise observed until waitForStart() reads it.
    void turn.start.promise.catch(() => undefined);

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { queued: [] };
      this.sessions.set(sessionId, session);
    }
    if (!session.current) {
      session.current = turn;
      turn.phase = "reserved";
      turn.start.resolve(undefined);
    } else {
      session.queued.push(turn);
    }

    if (signal) {
      turn.onExternalAbort = () => {
        this.cancelTurn(turn, abortReason(signal, "SDK turn cancelled."));
      };
      signal.addEventListener("abort", turn.onExternalAbort, { once: true });
    }

    return this.reservationFor(turn);
  }

  getCurrent(sessionId: string): SessionTurnReservation | undefined {
    const turn = this.sessions.get(sessionId)?.current;
    return turn ? this.reservationFor(turn) : undefined;
  }

  getState(sessionId: string): SessionTurnQueueState {
    if (this.deletedSessions.has(sessionId)) {
      return { active: false, queued: 0, phase: "deleted" };
    }
    const session = this.sessions.get(sessionId);
    const currentPhase = session?.current?.phase;
    return {
      active: Boolean(session?.current),
      queued: session?.queued.length ?? 0,
      phase: currentPhase && currentPhase !== "queued" && currentPhase !== "settled"
        ? currentPhase
        : "idle",
    };
  }

  stop(sessionId: string, message = "SDK turn stopped."): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    const turns = [session.current, ...session.queued].filter((turn): turn is TurnRecord => Boolean(turn));
    for (const turn of turns) this.cancelTurn(turn, new AgentAbortError(message));
    return turns.length;
  }

  stopCurrent(sessionId: string, message = "SDK turn stopped."): number {
    const current = this.sessions.get(sessionId)?.current;
    if (!current) return 0;
    this.cancelTurn(current, new AgentAbortError(message));
    return 1;
  }

  clearQueue(sessionId: string, message = "Queued SDK turn cancelled."): number {
    const queued = [...(this.sessions.get(sessionId)?.queued ?? [])];
    for (const turn of queued) this.cancelTurn(turn, new AgentAbortError(message));
    return queued.length;
  }

  async delete(sessionId: string): Promise<void> {
    this.deletedSessions.add(sessionId);
    const session = this.sessions.get(sessionId);
    const turns = session
      ? [session.current, ...session.queued].filter((turn): turn is TurnRecord => Boolean(turn))
      : [];
    for (const turn of turns) {
      this.cancelTurn(turn, new AgentAbortError("SDK session deleted."));
    }
    await Promise.all(turns.map((turn) => turn.completion.promise));
  }

  isDeleted(sessionId: string): boolean {
    return this.deletedSessions.has(sessionId);
  }

  revive(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.current || session?.queued.length) {
      throw new Error(`Cannot recreate session while turns are still settling: ${sessionId}`);
    }
    this.deletedSessions.delete(sessionId);
  }

  private reservationFor(turn: TurnRecord): SessionTurnReservation {
    return {
      id: turn.id,
      sessionId: turn.sessionId,
      signal: turn.abort.signal,
      get phase() {
        return turn.phase;
      },
      completion: turn.completion.promise,
      waitForStart: async () => {
        await turn.start.promise;
        if (turn.phase === "settled") throw turn.terminalError ?? new AgentAbortError("SDK turn cancelled.");
        if (turn.phase === "reserved") turn.phase = "starting";
        throwIfAborted(turn.abort.signal);
      },
      markActive: () => {
        throwIfAborted(turn.abort.signal);
        if (turn.phase === "starting") turn.phase = "active";
      },
      cancel: (error = new AgentAbortError("SDK turn cancelled.")) => {
        this.cancelTurn(turn, error);
      },
      finish: () => this.finishTurn(turn),
    };
  }

  private cancelTurn(turn: TurnRecord, error: Error): void {
    if (turn.phase === "settled") return;
    turn.terminalError = error;
    turn.abort.abort(error);

    const session = this.sessions.get(turn.sessionId);
    if (!session) {
      this.settleDetached(turn);
      return;
    }
    if (turn.phase === "queued") {
      const index = session.queued.indexOf(turn);
      if (index >= 0) session.queued.splice(index, 1);
      this.settleDetached(turn);
      this.deleteEmptySession(turn.sessionId, session);
      return;
    }
    if (turn.phase === "reserved") {
      if (session.current === turn) session.current = undefined;
      this.settleDetached(turn);
      this.promoteNext(turn.sessionId, session);
      return;
    }
    turn.phase = "stopping";
  }

  private finishTurn(turn: TurnRecord): void {
    if (turn.phase === "settled") return;
    const session = this.sessions.get(turn.sessionId);
    if (session?.current === turn) session.current = undefined;
    this.settleDetached(turn);
    if (session) this.promoteNext(turn.sessionId, session);
  }

  private settleDetached(turn: TurnRecord): void {
    this.detachExternalAbort(turn);
    const error = turn.terminalError;
    turn.phase = "settled";
    if (error) turn.start.reject(error);
    turn.completion.resolve(undefined);
  }

  private promoteNext(sessionId: string, session: SessionRecord): void {
    if (this.deletedSessions.has(sessionId)) {
      for (const queued of [...session.queued]) {
        this.cancelTurn(queued, new AgentAbortError("SDK session deleted."));
      }
      this.deleteEmptySession(sessionId, session);
      return;
    }
    while (!session.current && session.queued.length > 0) {
      const next = session.queued.shift();
      if (!next || next.phase === "settled") continue;
      session.current = next;
      next.phase = "reserved";
      next.start.resolve(undefined);
    }
    this.deleteEmptySession(sessionId, session);
  }

  private deleteEmptySession(sessionId: string, session: SessionRecord): void {
    if (!session.current && session.queued.length === 0) this.sessions.delete(sessionId);
  }

  private detachExternalAbort(turn: TurnRecord): void {
    if (turn.externalSignal && turn.onExternalAbort) {
      turn.externalSignal.removeEventListener("abort", turn.onExternalAbort);
    }
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new AgentAbortError(typeof signal.reason === "string" ? signal.reason : fallback);
}

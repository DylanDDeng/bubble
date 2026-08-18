/**
 * Headless spy host: deterministic ports for controller tests.
 * Records every effect and snapshot version so integration tests can assert
 * exact sequences without a terminal.
 */
import type { BubbleTuiPorts, FlushScheduler } from "../controller/ports.js";
import type { ControllerEffect } from "../controller/effects.js";

export class SpyHost {
  readonly effects: ControllerEffect[] = [];
  readonly snapshotVersions: number[] = [];
  private flushPending: { flush: () => void } | null = null;
  private nowMs = 10_000;

  readonly ports: BubbleTuiPorts = {
    clock: { now: () => this.nowMs },
    scheduler: {
      setTimeout: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return { [Symbol.dispose ?? Symbol.for("nodejs.dispose")]: () => clearTimeout(timer) } as Disposable;
      },
      setInterval: (callback, ms) => {
        const timer = setInterval(callback, ms);
        return { [Symbol.dispose ?? Symbol.for("nodejs.dispose")]: () => clearInterval(timer) } as Disposable;
      },
    },
    flush: {
      scheduleFlush: (_intervalMs, flush) => {
        this.flushPending ??= { flush };
      },
      cancelFlush: () => {
        this.flushPending = null;
      },
    } satisfies FlushScheduler,
    terminal: { isMultiplexed: () => false },
    sessionHost: {
      switchSession: () => ({ error: "spy host: switchSession not configured" }),
      createFresh: () => {
        throw new Error("spy host: createFresh not configured");
      },
    },
    git: { currentBranch: () => undefined },
    exitProcess: (code) => {
      this.exitCodes.push(code);
    },
  };

  readonly exitCodes: number[] = [];

  /** Fire any pending debounced flush (simulates the 40ms timer). */
  fireFlush(): void {
    const pending = this.flushPending;
    this.flushPending = null;
    pending?.flush();
  }

  advanceNow(deltaMs: number): void {
    this.nowMs += deltaMs;
  }

  recordEffect(effect: ControllerEffect): void {
    this.effects.push(effect);
  }

  recordSnapshot(version: number): void {
    this.snapshotVersions.push(version);
  }

  effectsOf(kind: ControllerEffect["kind"]): ControllerEffect[] {
    return this.effects.filter((effect) => effect.kind === kind);
  }
}

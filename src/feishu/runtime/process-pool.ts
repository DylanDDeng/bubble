/**
 * Global concurrency cap. FIFO queue of tasks; at most `concurrency` in
 * flight at any time.
 *
 * Bubble agents are CPU-light but LLM-network-heavy. The cap exists to
 * (a) cap egress bandwidth and (b) keep API rate-limit failures localized.
 */

export interface ProcessPoolOptions {
  concurrency: number;
}

export class ProcessPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly opts: ProcessPoolOptions) {
    if (opts.concurrency < 1) {
      throw new Error(`ProcessPool concurrency must be >= 1, got ${opts.concurrency}`);
    }
  }

  /**
   * Acquire a slot. Caller must call `release()` exactly once when done
   * (or use `run()` for the safer wrapped variant).
   */
  async acquire(): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Run `fn` with a pool slot held; releases on settle. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  status(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiters.length, cap: this.opts.concurrency };
  }
}

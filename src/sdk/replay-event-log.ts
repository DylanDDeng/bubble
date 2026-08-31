interface DeferredSignal {
  promise: Promise<void>;
  resolve(): void;
}

/**
 * A small append-only event log for SDK streams. Producers never wait for a
 * consumer, and consumers can attach again with their last seen sequence.
 */
export class ReplayEventLog<T> {
  private readonly entries: T[] = [];
  private signal = deferredSignal();
  private closed = false;
  private failure: unknown;

  get length(): number {
    return this.entries.length;
  }

  append(value: T): void {
    if (this.closed) return;
    this.entries.push(value);
    this.wake();
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.wake();
  }

  iterate(options: { from?: number; signal?: AbortSignal } = {}): AsyncGenerator<T> {
    const start = Math.max(0, options.from ?? 0);
    return this.readFrom(start, options.signal);
  }

  private async *readFrom(start: number, abortSignal?: AbortSignal): AsyncGenerator<T> {
    let index = start;
    while (true) {
      while (index < this.entries.length) yield this.entries[index++]!;
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      if (abortSignal?.aborted) return;
      const currentSignal = this.signal.promise;
      await waitForSignal(currentSignal, abortSignal);
    }
  }

  private wake(): void {
    const previous = this.signal;
    this.signal = deferredSignal();
    previous.resolve();
  }
}

function deferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForSignal(signal: Promise<void>, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return signal;
  if (abortSignal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      abortSignal.removeEventListener("abort", done);
      resolve();
    };
    abortSignal.addEventListener("abort", done, { once: true });
    signal.then(done);
  });
}

interface DeferredSignal {
  promise: Promise<void>;
  resolve(): void;
}

/**
 * A small append-only event log for SDK streams. Producers never wait for a
 * consumer, and consumers can attach again with their last seen sequence.
 */
export class ReplayEventLog<T> {
  private readonly entries = new Map<number, T>();
  private nextIndex = 0;
  private firstIndex = 0;
  private readonly readers = new Map<object, number>();
  private signal = deferredSignal();
  private closed = false;
  private failure: unknown;

  constructor(private readonly retention = Infinity) {
    if (retention !== Infinity && (!Number.isSafeInteger(retention) || retention < 1)) throw new Error('Invalid event retention');
  }

  get length(): number {
    return this.nextIndex;
  }

  get retainedCount(): number { return this.entries.size; }

  append(value: T): void {
    if (this.closed) return;
    this.entries.set(this.nextIndex++, value);
    this.prune();
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
    const reader = {};
    const cancelled = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, cancelled.signal]) : cancelled.signal;
    const release = () => { this.readers.delete(reader); this.prune(); };
    // Reserve the cursor when subscribing, before a synchronous producer can
    // prune events and before the consumer calls next(). close/return also
    // release subscriptions which were never advanced.
    if (!signal.aborted) this.readers.set(reader, start);
    signal.addEventListener('abort', release, { once: true });
    const cleanup = () => { signal.removeEventListener('abort', release); release(); };
    const iterator = this.readFrom(start, reader, signal, cleanup);
    const finish = iterator.return.bind(iterator);
    const fail = iterator.throw.bind(iterator);
    iterator.return = async value => { cancelled.abort(); cleanup(); return finish(value); };
    iterator.throw = async error => { cancelled.abort(); cleanup(); return fail(error); };
    return iterator;
  }

  private async *readFrom(start: number, reader: object, abortSignal: AbortSignal, cleanup: () => void): AsyncGenerator<T> {
    let index = start;
    try {
      while (true) {
        while (index < this.nextIndex) {
          if (abortSignal.aborted) return;
          if (index < this.firstIndex) {
            throw new Error('Replay cursor expired; restore persisted history and subscribe from the latest sequence.');
          }
          const value = this.entries.get(index)!;
          this.readers.set(reader, ++index);
          this.prune();
          yield value;
        }
        if (this.closed) {
          if (this.failure !== undefined) throw this.failure;
          return;
        }
        if (abortSignal.aborted) return;
        const currentSignal = this.signal.promise;
        await waitForSignal(currentSignal, abortSignal);
      }
    } finally {
      cleanup();
    }
  }

  private prune(): void {
    if (this.retention === Infinity) return;
    let before = this.nextIndex - this.retention;
    for (const index of this.readers.values()) before = Math.min(before, index);
    while (this.firstIndex < before) this.entries.delete(this.firstIndex++);
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

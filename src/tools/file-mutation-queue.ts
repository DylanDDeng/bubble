import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();

function queueKey(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = queueKey(filePath);
  const current = queues.get(key) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((resolveNext) => {
    release = resolveNext;
  });
  const chained = current.then(() => next);
  queues.set(key, chained);

  await current;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === chained) {
      queues.delete(key);
    }
  }
}

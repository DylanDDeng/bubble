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
  return withQueueKey(queueKey(filePath), fn);
}

export async function withFileMutationQueues<T>(filePaths: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(filePaths.map(queueKey))].sort();

  const run = (index: number): Promise<T> => {
    if (index >= keys.length) return fn();
    return withQueueKey(keys[index], () => run(index + 1));
  };

  return run(0);
}

async function withQueueKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

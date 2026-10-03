import { resolve } from 'node:path';
import type { ProjectTreeNode } from '../types';

type Tree = ProjectTreeNode | null;
type Scan = {
  controller: AbortController;
  promise: Promise<Tree>;
  readers: number;
  settled: boolean;
};

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** Share in-flight trees, not completed trees; keep cancelled scans tracked until they stop. */
export function createProjectTreeReader(scanTree: (cwd: string, signal: AbortSignal) => Promise<Tree>) {
  const active = new Map<string, Scan>();
  let disposed = false;

  const read = async (cwd: string, signal?: AbortSignal): Promise<Tree> => {
    signal?.throwIfAborted();
    if (disposed) throw new Error('Project tree reader is closed.');
    const root = resolve(cwd);
    let scan = active.get(root);
    if (scan?.controller.signal.aborted) {
      // A cancelled filesystem operation may still be unwinding. Starting its
      // replacement immediately would reintroduce overlapping traversals.
      await waitWithSignal(scan.promise.then(() => undefined, () => undefined), signal);
      return read(root, signal);
    }
    if (!scan) {
      const controller = new AbortController();
      const next: Scan = { controller, promise: undefined!, readers: 0, settled: false };
      const finish = () => {
        next.settled = true;
        if (active.get(root) === next) active.delete(root);
      };
      next.promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return scanTree(root, controller.signal);
      }).then(value => { finish(); return value; }, error => { finish(); throw error; });
      active.set(root, next);
      scan = next;
    }
    scan.readers++;
    try {
      return await waitWithSignal(scan.promise, signal);
    } finally {
      scan.readers--;
      // Cancelling one panel must not cancel a tree still used by another.
      if (!scan.readers && !scan.settled) scan.controller.abort();
    }
  };

  return {
    read,
    async readFresh(cwd: string, signal?: AbortSignal): Promise<Tree> {
      signal?.throwIfAborted();
      const previous = active.get(resolve(cwd));
      if (previous) {
        await waitWithSignal(previous.promise.then(() => undefined, () => undefined), signal);
      }
      // File mutations and watcher events need a scan begun after the change.
      return read(cwd, signal);
    },
    dispose() {
      disposed = true;
      for (const scan of active.values()) scan.controller.abort();
    },
  };
}

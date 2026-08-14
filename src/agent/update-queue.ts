/**
 * Wake-latched update queue shared by the agent run loop: tool updates,
 * subagent deliveries and workflow completions all park here until the loop
 * is ready to drain them.
 */

/** Exported for tests: the wake latch below is easiest to pin directly. */
export function createUpdateQueue<T>() {
  const items: T[] = [];
  let waiter: ((status: "woken" | "aborted") => void) | undefined;
  let abortCleanup: (() => void) | undefined;
  // Latch for wakes that arrive with no parked waiter — a wake() fired while
  // the consuming generator is suspended at a yield would otherwise be lost.
  // Callers today each pair their wake with a synchronously-checked flag
  // (items / settled / pendingSubagentUpdates), so no wake is currently
  // dropped; the latch keeps that correctness inside the queue instead of
  // depending on every future caller repeating the pairing.
  let signaled = false;
  return {
    push(item: T) {
      items.push(item);
      this.wake();
    },
    drain(): T[] {
      return items.splice(0, items.length);
    },
    hasItems(): boolean {
      return items.length > 0;
    },
    wait(signal?: AbortSignal): Promise<"woken" | "aborted"> {
      if (items.length > 0) return Promise.resolve("woken");
      if (signaled) {
        signaled = false;
        return Promise.resolve("woken");
      }
      if (signal?.aborted) return Promise.resolve("aborted");
      return new Promise((resolve) => {
        abortCleanup?.();
        abortCleanup = undefined;
        const finish = (status: "woken" | "aborted") => {
          if (waiter !== resolve) return;
          waiter = undefined;
          abortCleanup?.();
          abortCleanup = undefined;
          resolve(status);
        };
        if (signal) {
          const onAbort = () => finish("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => signal.removeEventListener("abort", onAbort);
        }
        waiter = resolve;
      });
    },
    wake() {
      const resolve = waiter;
      if (!resolve) {
        signaled = true;
        return;
      }
      waiter = undefined;
      abortCleanup?.();
      abortCleanup = undefined;
      resolve("woken");
    },
  };
}

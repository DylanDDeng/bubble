/** Debounce changes without allowing slow refreshes to overlap. */
export function createCoalescedRefresh(
  refresh: (signal: AbortSignal) => Promise<void>,
  delayMs: number,
  onError: (error: unknown) => void,
): { schedule(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let dirty = false;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    dirty = true;
    if (active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      dirty = false;
      const controller = new AbortController();
      active = controller;
      void (async () => {
        try {
          await refresh(controller.signal);
        } catch (error) {
          if (!stopped) onError(error);
        } finally {
          active = undefined;
          if (dirty && !stopped) schedule();
        }
      })();
    }, delayMs);
  };

  return {
    schedule,
    stop() {
      stopped = true;
      dirty = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      active?.abort();
    },
  };
}

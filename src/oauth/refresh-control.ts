export const OAUTH_REFRESH_TIMEOUT_MS = 30_000;

/** Cancel only this caller's wait, never the shared credential rotation.
 * Keep both handlers attached after cancellation so a late refresh rejection
 * is observed even when every caller has stopped waiting.
 */
export function waitForOAuth<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** The refresh owner has its own deadline, independent of any chat's signal.
 * Cover response-body reads as well as connection/headers, and release callers
 * even if a custom transport fails to honor abort. Only the returned result may
 * be persisted by the registry; a late response after timeout is discarded.
 */
export async function withOAuthRefreshTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = OAUTH_REFRESH_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid OAuth refresh timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("OAuth token refresh timed out. Please try again.");
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  timer.unref?.();
  try {
    return await waitForOAuth(request(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

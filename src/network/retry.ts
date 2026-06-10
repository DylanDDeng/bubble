/**
 * Shared retry policy for provider transports.
 *
 * Connection-level failures (nothing received yet) and retryable HTTP
 * statuses are retried inside the provider with exponential backoff.
 * Mid-stream interruptions (content already surfaced to the UI) are
 * signalled with ProviderStreamInterruptedError so the agent loop can
 * discard the partial assistant message and re-issue the whole request.
 */

const DEFAULT_MAX_RETRIES = 4;
const MAX_CONFIGURABLE_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32_000;
const MAX_RETRY_AFTER_MS = 60_000;

export const MAX_STREAM_INTERRUPTION_RETRIES = 2;

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export class ProviderStreamInterruptedError extends Error {
  readonly isProviderStreamInterruption = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderStreamInterruptedError";
  }
}

export function isProviderStreamInterruption(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && (error as { isProviderStreamInterruption?: unknown }).isProviderStreamInterruption === true;
}

export function getProviderMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BUBBLE_PROVIDER_MAX_RETRIES?.trim();
  if (!raw) return DEFAULT_MAX_RETRIES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return DEFAULT_MAX_RETRIES;
  return Math.min(value, MAX_CONFIGURABLE_RETRIES);
}

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

/**
 * Equal-jitter exponential backoff: attempt 1 → 0.5-1s, 2 → 1-2s, 3 → 2-4s,
 * 4 → 4-8s, capped at 32s. A retry-after hint from the server wins (capped
 * at 60s) since it reflects actual load shedding.
 */
export function computeRetryDelayMs(attempt: number, options?: { retryAfterMs?: number }): number {
  if (process.env.NODE_ENV === "test") return 0;
  if (options?.retryAfterMs !== undefined && options.retryAfterMs >= 0) {
    return Math.min(options.retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(cap / 2 + Math.random() * (cap / 2));
}

export function retryAfterMsFromResponse(response: Response): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function sleepBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(toAbortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(toAbortError(signal));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal?.reason === "string" ? signal.reason : "Request retry aborted.");
  error.name = "AbortError";
  return error;
}

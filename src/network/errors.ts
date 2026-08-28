/**
 * Typed transport errors shared between providers and the subagent runtime.
 *
 * `RateLimitError` is the contract for 429 handling (design doc
 * docs/subagent-runtime-design.md §4.5): under `rateLimitPolicy: "defer"` the
 * transport performs no 429 backoff of its own and throws this error
 * immediately so the subagent scheduler can be the single backoff layer.
 */

export class RateLimitError extends Error {
  readonly isRateLimitError = true;
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { status?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RateLimitError";
    this.status = options?.status ?? 429;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return !!error
    && typeof error === "object"
    && (error as { isRateLimitError?: unknown }).isRateLimitError === true;
}

/**
 * A provider accepted the HTTP request but terminated generation with an
 * in-band protocol error (for example OpenRouter's HTTP-200 SSE error chunk).
 * Keeping the wire status/type structured prevents the agent from mistaking
 * the terminal event for a successful empty response.
 */
export class ProviderResponseError extends Error {
  readonly isProviderResponseError = true;
  readonly status?: number;
  readonly errorType?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: {
    status?: number;
    errorType?: string;
    retryAfterMs?: number;
    cause?: unknown;
  } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderResponseError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isProviderResponseError(error: unknown): error is ProviderResponseError {
  return !!error
    && typeof error === "object"
    && (error as { isProviderResponseError?: unknown }).isProviderResponseError === true;
}

/**
 * How a provider transport should treat HTTP 429 responses.
 *
 * - "handle": retry inside the transport with backoff (parent traffic default).
 * - "defer":  do not retry 429 at all; throw RateLimitError immediately so the
 *             caller (subagent scheduler) owns the backoff. Other retryable
 *             statuses are unaffected.
 */
export type RateLimitPolicy = "handle" | "defer";

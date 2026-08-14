export class AgentAbortError extends Error {
  constructor(message = "Agent run cancelled.") {
    super(message);
    this.name = "AgentAbortError";
  }
}

/**
 * Abort tagged with why the runtime stopped a child, so finalization can map
 * it to a SubagentFinalReason (design doc §3.1) instead of guessing from
 * message strings.
 */
export class SubagentAbortError extends AgentAbortError {
  constructor(message: string, readonly subagentReason: "interrupt" | "user_close") {
    super(message);
    this.name = "SubagentAbortError";
  }
}

/** Shown when the model produced no user-visible content despite recovery attempts. */
export const EMPTY_ASSISTANT_FALLBACK =
  "The model returned no user-visible response. Please retry, or switch models if this keeps happening.";

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new AgentAbortError(typeof reason === "string" ? reason : undefined);
}

export function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof AgentAbortError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") return true;
  return false;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return isAbortLikeError(error, signal);
}

export function summarizeInterruptError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

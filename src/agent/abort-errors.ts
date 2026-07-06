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

/**
 * Workflow error tiers (design v2 appendix / option C review MAJOR-1).
 *
 * - WorkflowAgentError: a single agent() did not complete. Inside parallel()/
 *   pipeline() it degrades that item to null; a direct `await agent()` throws it.
 * - WorkflowAbortError: the whole run is being torn down (budget exhausted,
 *   user/parent abort, deadline). Combinators must NOT swallow it — the run halts.
 */

export class WorkflowAgentError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = "WorkflowAgentError";
  }
}

export class WorkflowAbortError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = "WorkflowAbortError";
  }
}

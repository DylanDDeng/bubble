import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import { createSanitizedProviderError, type ProviderErrorContext } from "../provider-error-record.js";

export interface ProviderTransportFailureContext extends ProviderErrorContext {
  sessionId: string;
  requestId: string;
  attempt: number;
  responseStatus?: number;
  receivedEvents: number;
  elapsedMs: number;
  lastEventAgeMs?: number;
  decision: "retry" | "delegate_retry" | "fail" | "cancelled";
}

// Failure-only diagnostics are enabled without BUBBLE_TRACE. Keep at most two
// 2 MiB files; never persist request/response bodies, headers, or raw errors.
export function logProviderTransportFailure(error: unknown, context: ProviderTransportFailureContext): void {
  try {
    const dir = join(getBubbleHome(), "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "provider-transport.jsonl");
    if (existsSync(file) && statSync(file).size >= 2 * 1024 * 1024) {
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: "provider_transport_failure",
      sessionId: context.sessionId,
      requestId: context.requestId,
      attempt: context.attempt,
      responseStatus: context.responseStatus,
      receivedEvents: context.receivedEvents,
      elapsedMs: context.elapsedMs,
      lastEventAgeMs: context.lastEventAgeMs,
      decision: context.decision,
      error: createSanitizedProviderError(error, context),
    }) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // Disk errors and concurrent rotation must never affect the request.
  }
}

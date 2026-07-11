import { isGrokSubscriptionProviderId } from "./grok-provider.js";
import type { ExternalRuntimeManager } from "./types.js";

export type ExternalRuntimeBindingKind = "none" | "grok" | "unsupported";

/**
 * Treat every persisted external-runtime marker as non-native. Known aliases
 * normalize to Grok; malformed or future IDs stay fail-closed instead of
 * falling through to Bubble's native agent/tool path.
 */
export function classifyExternalRuntimeBinding(binding: unknown): ExternalRuntimeBindingKind {
  if (binding === undefined) return "none";
  const id = typeof binding === "string"
    ? binding
    : binding !== null && typeof binding === "object" && "id" in binding
      ? (binding as { id?: unknown }).id
      : undefined;
  return typeof id === "string" && isGrokSubscriptionProviderId(id)
    ? "grok"
    : "unsupported";
}

export async function stopExternalRuntimeForSessionSwitch(
  runtime: ExternalRuntimeManager | undefined,
  sessionId?: string,
): Promise<void> {
  if (!runtime) {
    throw new Error("The external runtime manager is unavailable; the current session was not changed.");
  }
  if (sessionId) await runtime.cancel(sessionId);
  await runtime.dispose();
}

/** Never replay a Grok-owned transcript through Bubble's native print path. */
export function shouldRejectGrokSessionInPrintMode(
  externalRuntimeBinding: unknown,
  printMode: boolean,
): boolean {
  return printMode && classifyExternalRuntimeBinding(externalRuntimeBinding) !== "none";
}

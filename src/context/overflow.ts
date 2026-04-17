/**
 * Context-overflow detection.
 *
 * When the upstream provider rejects a request because the prompt exceeds
 * the effective context window, we catch the error here so the agent can
 * compact history and retry automatically.
 */

const OVERFLOW_PATTERNS: RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /exceeds the context window/i,
  /exceeds the limit of\s+\d+/i,
  /prompt is too long/i,
  /maximum context length/i,
  /too many tokens/i,
];

export function isContextOverflowError(error: unknown): boolean {
  if (!error) return false;
  const messages: string[] = [];
  if (typeof error === "string") {
    messages.push(error);
  } else if (error instanceof Error) {
    messages.push(error.message);
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) messages.push(cause.message);
    else if (typeof cause === "string") messages.push(cause);
  } else if (typeof error === "object") {
    const anyErr = error as Record<string, unknown>;
    if (typeof anyErr.message === "string") messages.push(anyErr.message);
    const nested = anyErr.error;
    if (nested && typeof nested === "object" && typeof (nested as any).message === "string") {
      messages.push((nested as any).message);
    }
  }
  return messages.some((msg) => OVERFLOW_PATTERNS.some((re) => re.test(msg)));
}

export function isContextOverflowByUsage(
  inputTokens: number | undefined,
  contextWindow: number | undefined,
): boolean {
  if (!inputTokens || !contextWindow) return false;
  return inputTokens > contextWindow;
}

import { ProviderStreamInterruptedError } from "./network/retry.js";

/** Only Zen's opaque upstream rejection is recoverable, not arbitrary 422s. */
export function isSpaceBunnyUpstreamRejection(providerId: string | undefined, model: string, error: unknown): boolean {
  if (providerId !== "opencode-zen" || model !== "space-bunny-free") return false;
  const e = error as { status?: unknown; message?: unknown } | null;
  return e?.status === 422 && typeof e.message === "string"
    && /Upstream request failed:\s*\[invalid_request_error\]\s*unprocessable entity/i.test(e.message);
}

export function recoverableSpaceBunnyError(error: unknown): ProviderStreamInterruptedError {
  return new ProviderStreamInterruptedError("Space Bunny upstream rejected the request (422); retrying the model request.", {
    cause: error, maxRetries: 2,
  });
}

/** Counts only: never persist prompts, tool arguments, URLs or API headers. */
export function chatRequestShape(body: { messages?: Record<string, unknown>[]; tools?: unknown[] }): Record<string, number> {
  const messages = body.messages ?? [];
  const shape = { messages: messages.length, tools: body.tools?.length ?? 0, assistant: 0,
    emptyAssistant: 0, reasoning: 0, toolCalls: 0, toolResults: 0, contentChars: 0 };
  for (const m of messages) {
    if (typeof m.content === "string") shape.contentChars += m.content.length;
    if (m.role === "assistant") {
      shape.assistant++;
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.length : 0;
      shape.toolCalls += calls;
      if (!m.content && !calls) shape.emptyAssistant++;
      if (m.reasoning_content) shape.reasoning++;
    }
    if (m.role === "tool") shape.toolResults++;
  }
  return shape;
}

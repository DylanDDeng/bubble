import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicMessagesProvider } from "../provider-anthropic.js";
import { isRateLimitError } from "../network/errors.js";

function rateLimited429(): Response {
  return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Too many requests" } }), {
    status: 429,
    headers: { "retry-after": "2" },
  });
}

describe("Anthropic transport rate-limit policy (design §4.5)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('"defer" performs no 429 backoff: one request, typed RateLimitError with retryAfterMs', async () => {
    const fetchSpy = vi.fn(async () => rateLimited429());
    globalThis.fetch = fetchSpy as any;
    const provider = createAnthropicMessagesProvider({ apiKey: "k", baseURL: "https://api.anthropic.com" } as any);

    let caught: unknown;
    try {
      for await (const _chunk of provider.streamChat([{ role: "user", content: "hi" }], {
        model: "claude-sonnet-4-6",
        rateLimitPolicy: "defer",
      })) {
        // no chunks expected
      }
    } catch (error) {
      caught = error;
    }

    expect(isRateLimitError(caught)).toBe(true);
    expect((caught as any).retryAfterMs).toBe(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('"handle" retries inside the transport and still surfaces a typed RateLimitError on exhaustion', async () => {
    const fetchSpy = vi.fn(async () => rateLimited429());
    globalThis.fetch = fetchSpy as any;
    const provider = createAnthropicMessagesProvider({ apiKey: "k", baseURL: "https://api.anthropic.com" } as any);

    let caught: unknown;
    try {
      for await (const _chunk of provider.streamChat([{ role: "user", content: "hi" }], {
        model: "claude-sonnet-4-6",
      })) {
        // no chunks expected
      }
    } catch (error) {
      caught = error;
    }

    expect(isRateLimitError(caught)).toBe(true);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshOpenAICodex } from "../oauth/openai-codex.js";
import { refreshGrok } from "../oauth/grok.js";
import { waitForOAuth } from "../oauth/refresh-control.js";
import { createGrokSubscriptionFetch } from "../provider-grok.js";

afterEach(() => vi.useRealTimers());

describe.each([
  ["OpenAI", refreshOpenAICodex], ["Grok", refreshGrok],
] as const)("%s refresh deadline", (_name, refresh) => {
  it.each(["headers", "success-body", "error-body"])("bounds a stalled %s read", async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    let release!: (value: any) => void;
    const pending = new Promise<any>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      if (stage === "headers") return pending;
      return { ok: stage === "success-body", status: 401, statusText: "Unauthorized",
        json: () => pending, text: () => pending } as Response;
    });
    const result = refresh("fixture", { fetch, timeoutMs: 100 }).then(() => null, error => error as Error);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect((await result)?.name).toBe("TimeoutError");
      expect(signal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      release(stage === "headers"
        ? Response.json({ access_token: "late", expires_in: 3600 })
        : stage === "success-body" ? { access_token: "late", expires_in: 3600 } : "late error");
    }
  });

  it("clears the deadline on success", async () => {
    vi.useFakeTimers();
    await refresh("fixture", { fetch: async () => Response.json({ access_token: "fresh", expires_in: 3600 }), timeoutMs: 100 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("caller cancellation without cancelling shared refresh", () => {
  it("detaches one waiter, preserves another, and removes abort listeners", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let release!: (value: string) => void;
    const shared = new Promise<string>(resolve => { release = resolve; });
    const cancelled = waitForOAuth(shared, controller.signal).catch(error => error);
    const remaining = waitForOAuth(shared, new AbortController().signal);
    const reason = new Error("stopped");
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect(remove).toHaveBeenCalled();
    release("fresh");
    expect(await remaining).toBe("fresh");
  });

  it.each([false, true])("observes late rejections even with an already-cancelled caller=%s", async alreadyCancelled => {
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    if (alreadyCancelled) controller.abort();
    const cancelled = waitForOAuth(pending, controller.signal).catch(error => error);
    controller.abort();
    expect((await cancelled).name).toBe("AbortError");
    fail(new Error("late refresh failure"));
    await new Promise(resolve => setImmediate(resolve)); // Vitest catches unhandled rejections.
  });

  it("Grok stops waiting without aborting another request's shared renewal", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let credentials = { type: "oauth" as const, accessToken: "old", refreshToken: "refresh", expiresAt: 0 };
    const refreshCredentials = vi.fn(async () => {
      await gate;
      credentials = { ...credentials, accessToken: "fresh", expiresAt: Date.now() + 3_600_000 };
      return credentials;
    });
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const request = createGrokSubscriptionFetch({ getCredentials: () => credentials, refreshCredentials }, fetch);
    const controller = new AbortController();
    const cancelled = request("https://fixture.invalid", { signal: controller.signal }).catch(error => error);
    const remaining = request("https://fixture.invalid");
    try {
      await vi.waitFor(() => expect(refreshCredentials).toHaveBeenCalledTimes(1));
      controller.abort();
      expect((await cancelled).name).toBe("AbortError");
      expect(fetch).not.toHaveBeenCalled();
      release();
      await remaining;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { release(); await Promise.allSettled([cancelled, remaining]); }
  });
});

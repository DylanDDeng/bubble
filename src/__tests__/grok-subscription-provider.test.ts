import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importGrokCliCredentials, refreshGrok } from "../oauth/grok.js";
import {
  buildGrokSubscriptionHeaders,
  createGrokSubscriptionFetch,
  fetchGrokSubscriptionModels,
  GROK_SUBSCRIPTION_BASE_URL,
  isGrokSubscriptionBaseUrl,
  type GrokAuthAdapter,
} from "../provider-grok.js";
import { getModelContextWindow, getModelDefaultReasoningLevel, inferGrokModelMetadata } from "../model-catalog.js";
import { getAvailableThinkingLevels, resolveProviderRequestConfig } from "../provider-transform.js";
import type { OAuthCredentials } from "../oauth/types.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("grok oauth refresh", () => {
  it("posts a public-client refresh grant and parses rotated tokens", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 21600,
      }), { status: 200 });
    });

    const tokens = await refreshGrok("old-refresh", { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith("https://auth.x.ai/oauth2/token", expect.anything());
    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("new-refresh");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 21_000_000);
  });

  it("keeps the previous refresh token when the server does not rotate it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "new-access",
      expires_in: 3600,
    }), { status: 200 }));

    const tokens = await refreshGrok("old-refresh", { fetch: fetchImpl });
    expect(tokens.refreshToken).toBe("old-refresh");
  });

  it("fails with the server detail when refresh is rejected", async () => {
    const fetchImpl = vi.fn(async () => new Response("revoked", { status: 400, statusText: "Bad Request" }));
    await expect(refreshGrok("old-refresh", { fetch: fetchImpl })).rejects.toThrow(/Token refresh failed: 400/);
  });
});

describe("grok CLI credential import", () => {
  // Both the bubbleHome candidate AND the ~/.grok fallback must point at
  // temp dirs: isolating only bubbleHome lets the second candidate fall
  // through to the developer's real ~/.grok/auth.json, and the "no usable
  // entry" test then fails on any machine with a live grok CLI login.
  const makeIsolatedHome = () => {
    const home = mkdtempSync(join(tmpdir(), "bubble-grok-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    return home;
  };

  it("imports the isolated runtime profile's auth entry", () => {
    const bubbleHome = mkdtempSync(join(tmpdir(), "bubble-grok-import-"));
    cleanups.push(() => rmSync(bubbleHome, { recursive: true, force: true }));
    const grokHome = join(bubbleHome, "runtimes", "grok", "grok-home");
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "auth.json"), JSON.stringify({
      "https://auth.x.ai::client-id": {
        key: "cli-access",
        refresh_token: "cli-refresh",
        expires_at: "2027-01-01T00:00:00.000Z",
      },
    }), { mode: 0o600 });

    const tokens = importGrokCliCredentials(bubbleHome, makeIsolatedHome());
    expect(tokens).toMatchObject({ accessToken: "cli-access", refreshToken: "cli-refresh" });
    expect(tokens?.expiresAt).toBe(Date.parse("2027-01-01T00:00:00.000Z"));
  });

  it("returns undefined when no usable entry exists", () => {
    const bubbleHome = mkdtempSync(join(tmpdir(), "bubble-grok-import-"));
    cleanups.push(() => rmSync(bubbleHome, { recursive: true, force: true }));
    const grokHome = join(bubbleHome, "runtimes", "grok", "grok-home");
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "auth.json"), JSON.stringify({
      "https://auth.x.ai::client-id": { key: "cli-access" },
      "unrelated-issuer::x": { key: "a", refresh_token: "b" },
    }), { mode: 0o600 });

    expect(importGrokCliCredentials(bubbleHome, makeIsolatedHome())).toBeUndefined();
  });
});

describe("grok subscription provider plumbing", () => {
  it("identifies the CLI chat proxy base URL", () => {
    expect(isGrokSubscriptionBaseUrl(GROK_SUBSCRIPTION_BASE_URL)).toBe(true);
    expect(isGrokSubscriptionBaseUrl(`${GROK_SUBSCRIPTION_BASE_URL}/`)).toBe(true);
    expect(isGrokSubscriptionBaseUrl("https://api.x.ai/v1")).toBe(false);
  });

  it("sends the pinned CLI identity headers", () => {
    expect(buildGrokSubscriptionHeaders()).toEqual({
      "User-Agent": "grok-cli",
      "x-grok-client-version": "0.2.93",
    });
  });

  it("injects a fresh bearer and refreshes single-flight when expired", async () => {
    let credentials: OAuthCredentials = {
      type: "oauth",
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: Date.now() - 1000,
    };
    const refreshCredentials = vi.fn(async () => {
      credentials = { ...credentials, accessToken: "fresh", expiresAt: Date.now() + 60 * 60 * 1000 };
      return credentials;
    });
    const seenAuth: Array<string | null> = [];
    const baseFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("Authorization"));
      return new Response("{}", { status: 200 });
    });
    const fetchImpl = createGrokSubscriptionFetch({
      getCredentials: () => credentials,
      refreshCredentials,
    }, baseFetch);

    await Promise.all([
      fetchImpl("https://cli-chat-proxy.grok.com/v1/chat/completions", {}),
      fetchImpl("https://cli-chat-proxy.grok.com/v1/chat/completions", {}),
    ]);
    await fetchImpl("https://cli-chat-proxy.grok.com/v1/chat/completions", {});

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(seenAuth).toEqual(["Bearer fresh", "Bearer fresh", "Bearer fresh"]);
  });

  it("maps thinking levels onto reasoning_effort for grok models", () => {
    expect(resolveProviderRequestConfig("grok", "grok-4.5", "high")).toEqual({
      effectiveThinkingLevel: "high",
      extraBody: { reasoning_effort: "high" },
    });
    expect(resolveProviderRequestConfig("grok", "grok-composer-2.5-fast", "off")).toEqual({
      effectiveThinkingLevel: "off",
      extraBody: undefined,
    });
  });
});

describe("grok subscription model discovery", () => {
  const futureCredentials = (): OAuthCredentials => ({
    type: "oauth",
    accessToken: "bearer-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  const futureAuth = (): GrokAuthAdapter => ({
    getCredentials: () => futureCredentials(),
    refreshCredentials: vi.fn(async () => futureCredentials()),
  });

  it("requests /models with the CLI identity headers and a fresh bearer", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const baseFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [
        { id: "grok-4.5" },
        { id: "grok-5-next", name: "Grok 5" },
      ] }), { status: 200 });
    });

    const models = await fetchGrokSubscriptionModels(
      GROK_SUBSCRIPTION_BASE_URL,
      futureAuth(),
      { fetch: baseFetch },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(seen[0].headers.get("user-agent")).toBe("grok-cli");
    expect(seen[0].headers.get("x-grok-client-version")).toBe("0.2.93");
    expect(seen[0].headers.get("authorization")).toBe("Bearer bearer-token");
    expect(models).toEqual([
      { id: "grok-4.5" },
      { id: "grok-5-next", name: "Grok 5" },
    ]);
  });

  it("parses the { models: [...] } response shape too", async () => {
    const baseFetch = vi.fn(async () => new Response(JSON.stringify({
      models: [{ id: "grok-4.5" }, { id: "grok-composer-2.5-fast" }],
    }), { status: 200 }));

    const models = await fetchGrokSubscriptionModels(
      GROK_SUBSCRIPTION_BASE_URL,
      futureAuth(),
      { fetch: baseFetch },
    );

    expect(models.map((model) => model.id)).toEqual(["grok-4.5", "grok-composer-2.5-fast"]);
  });

  it("extracts context window and reasoning efforts from the /models payload", async () => {
    const baseFetch = vi.fn(async () => new Response(JSON.stringify({ data: [
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        context_window: 1000000,
        reasoning_effort: "high",
        reasoning_efforts: [
          { value: "xhigh", label: "Extra High Effort", default: true },
          { value: "high", label: "High Effort", default: true },
          { value: "medium", label: "Medium Effort", default: false },
          { value: "low", label: "Low Effort", default: false },
        ],
      },
    ] }), { status: 200 }));

    const models = await fetchGrokSubscriptionModels(
      GROK_SUBSCRIPTION_BASE_URL,
      futureAuth(),
      { fetch: baseFetch },
    );

    expect(models).toEqual([{
      id: "grok-4.6",
      name: "Grok 4.6",
      contextWindow: 1000000,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "high",
    }]);
  });

  it("throws on a non-2xx so callers fall back to the curated catalog", async () => {
    const baseFetch = vi.fn(async () => new Response("not found", { status: 404 }));

    await expect(fetchGrokSubscriptionModels(
      GROK_SUBSCRIPTION_BASE_URL,
      futureAuth(),
      { fetch: baseFetch },
    )).rejects.toThrow(/HTTP 404/);
  });

  it("infers flagship reasoning levels and context window vs fast variants", () => {
    expect(inferGrokModelMetadata("grok-4.6")).toEqual({ levels: ["low", "medium", "high"], defaultLevel: "high", contextWindow: 500000 });
    expect(inferGrokModelMetadata("grok-5")).toEqual({ levels: ["low", "medium", "high"], defaultLevel: "high", contextWindow: 500000 });
    expect(inferGrokModelMetadata("grok-composer-2.5-fast")).toEqual({ levels: ["off"], contextWindow: 200000 });
    expect(inferGrokModelMetadata("grok-4.6-fast")).toEqual({ levels: ["off"], contextWindow: 200000 });
    expect(inferGrokModelMetadata("grok-mini")).toEqual({ levels: ["off"], contextWindow: 200000 });
  });

  it("resolves a context window for dynamic grok models before discovery", () => {
    // Static catalog entries resolve without any discovery.
    expect(getModelContextWindow("grok", "grok-4.5")).toBe(500000);
    // Dynamically-discovered ids resolve via id inference (no discovery needed).
    expect(getModelContextWindow("grok", "grok-4.6")).toBe(500000);
    expect(getModelContextWindow("grok", "grok-4.6-fast")).toBe(200000);
    // Non-grok providers are untouched.
    expect(getModelContextWindow("openai", "gpt-4o")).toBe(128000);
    expect(getModelContextWindow("openai", "gpt-unknown")).toBeUndefined();
  });

  it("resolves reasoning levels for dynamic grok models before discovery", () => {
    // Id inference gives the flagship ladder (xhigh only arrives via /models discovery).
    expect(getAvailableThinkingLevels("grok", "grok-4.6")).toEqual(["low", "medium", "high"]);
    expect(getModelDefaultReasoningLevel("grok", "grok-4.6")).toBe("high");
    expect(getAvailableThinkingLevels("grok", "grok-4.6-fast")).toEqual(["off"]);
  });
});

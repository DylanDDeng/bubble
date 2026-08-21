/**
 * Routing revision + cached discovery snapshot semantics
 * (docs/model-routing-design.md §1.4/§1.6).
 *
 * The revision must observe direct AuthStorage mutations (login/logout call
 * storage.set/.remove without going through registry methods), must NOT churn
 * on same-identity token rotation, and must bump on discovery-membership
 * changes — including across forced refreshes — while staying silent when a
 * re-discovery returns identical membership.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry, type ProviderProfile } from "../provider-registry.js";
import type { UserConfig } from "../config.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakeUserConfig(initialProviders: ProviderProfile[] = []): UserConfig {
  let providers = initialProviders.slice();
  return {
    getProviders: () => providers.slice(),
    setProviders: (next: ProviderProfile[]) => { providers = next.slice(); },
    getDefaultProvider: () => undefined,
    setDefaultProvider: () => undefined,
  } as unknown as UserConfig;
}

/** Registry with disk I/O neutralized: auth writes stay in memory, models.json is empty. */
function isolatedRegistry(initialProviders: ProviderProfile[] = []): ProviderRegistry {
  const registry = new ProviderRegistry(fakeUserConfig(initialProviders));
  (registry.getAuthStorage() as any).save = () => {};
  (registry as any).modelConfig = {
    getAllProviders: () => ({}),
    getCustomModels: () => [],
    hasProvider: () => false,
    getLoadError: () => undefined,
    getProviderConfig: () => undefined,
    getApiKey: () => undefined,
    getBaseURL: () => undefined,
    getProtocol: () => undefined,
    getPath: () => "/dev/null",
  };
  return registry;
}

const OPENROUTER: ProviderProfile = {
  id: "openrouter",
  name: "OpenRouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: "or-key",
  enabled: true,
  authType: "api",
};

function stubOpenRouterCatalog(ids: string[]) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({
      data: [
        {
          id: "stealth/ox-alpha",
          name: "Ox Alpha",
          context_length: 1048576,
          supported_parameters: ["reasoning", "tools"],
        },
        ...ids.map((id) => ({ id, name: id })),
      ],
    }),
  }));
}

describe("routing revision — provider mutations (§1.6)", () => {
  it("bumps on add/remove/updateProviderKey", () => {
    const registry = isolatedRegistry();
    const before = registry.getRoutingRevision();
    registry.addProvider("deepseek", "key-1");
    expect(registry.getRoutingRevision()).toBe(before + 1);
    registry.updateProviderKey("deepseek", "key-2");
    expect(registry.getRoutingRevision()).toBe(before + 2);
    registry.removeProvider("deepseek");
    expect(registry.getRoutingRevision()).toBe(before + 3);
  });
});

describe("routing revision — credential identity (§1.6)", () => {
  it("bumps on login and logout observed through direct AuthStorage mutations", () => {
    const registry = isolatedRegistry();
    const storage = registry.getAuthStorage();
    const before = registry.getRoutingRevision();
    storage.set("test-routing-oauth", {
      type: "oauth",
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 3600_000,
      accountId: "acct-1",
    });
    expect(registry.getRoutingRevision()).toBe(before + 1);
    storage.remove("test-routing-oauth");
    expect(registry.getRoutingRevision()).toBe(before + 2);
  });

  it("does NOT bump on same-identity access-token rotation", () => {
    const registry = isolatedRegistry();
    const storage = registry.getAuthStorage();
    storage.set("test-routing-oauth", {
      type: "oauth",
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 3600_000,
      accountId: "acct-1",
    });
    const afterLogin = registry.getRoutingRevision();
    // OAuth auto-refresh: new access token, same account identity.
    storage.set("test-routing-oauth", {
      type: "oauth",
      accessToken: "at-2-rotated",
      refreshToken: "rt-2-rotated",
      expiresAt: Date.now() + 7200_000,
      accountId: "acct-1",
    });
    expect(registry.getRoutingRevision()).toBe(afterLogin);
  });

  it("bumps on account switch (identity fingerprint change)", () => {
    const registry = isolatedRegistry();
    const storage = registry.getAuthStorage();
    storage.set("test-routing-oauth", {
      type: "oauth",
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 3600_000,
      accountId: "acct-1",
    });
    const afterLogin = registry.getRoutingRevision();
    storage.set("test-routing-oauth", {
      type: "oauth",
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: Date.now() + 3600_000,
      accountId: "acct-2",
    });
    expect(registry.getRoutingRevision()).toBe(afterLogin + 1);
  });
});

describe("routing revision — discovery membership (§1.6)", () => {
  it("ignores OpenRouter catalog churn outside the Ox Alpha allowlist", async () => {
    const registry = isolatedRegistry([OPENROUTER]);
    const provider = registry.getConfigured().find((item) => item.id === "openrouter")!;

    stubOpenRouterCatalog(["model-a", "model-b"]);
    const before = registry.getRoutingRevision();
    await registry.discoverModels(provider);
    expect(registry.getRoutingRevision()).toBe(before + 1);

    // Forced re-discovery with IDENTICAL membership: no bump.
    stubOpenRouterCatalog(["model-a", "model-b"]);
    await registry.discoverModels(provider, { forceRefresh: true });
    expect(registry.getRoutingRevision()).toBe(before + 1);

    // The upstream catalog changed, but Bubble's OpenRouter membership did
    // not: only Ox Alpha is exposed, so routing must not churn.
    stubOpenRouterCatalog(["model-a", "model-b", "model-c"]);
    await registry.discoverModels(provider, { forceRefresh: true });
    expect(registry.getRoutingRevision()).toBe(before + 1);
  });
});

describe("getCachedDiscoverySnapshot (§1.4)", () => {
  it("exposes a complete remote discovery and expires with the cache TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00Z"));
    const registry = isolatedRegistry([OPENROUTER]);
    const provider = registry.getConfigured().find((item) => item.id === "openrouter")!;
    stubOpenRouterCatalog(["model-a"]);
    await registry.discoverModels(provider);

    const snapshot = registry.getCachedDiscoverySnapshot("openrouter");
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.source).toBe("remote");
    expect(snapshot?.models.map((model) => model.id)).toEqual(["stealth/ox-alpha"]);

    // Past the 60s success TTL the snapshot is gone — never a stale authority.
    vi.setSystemTime(new Date("2026-07-12T00:01:01Z"));
    expect(registry.getCachedDiscoverySnapshot("openrouter")).toBeUndefined();
  });

  it("returns undefined for providers with no cached discovery", () => {
    const registry = isolatedRegistry([OPENROUTER]);
    expect(registry.getCachedDiscoverySnapshot("openrouter")).toBeUndefined();
  });
});

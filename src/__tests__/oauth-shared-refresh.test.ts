/**
 * Refresh tokens are single-use and auth.json is shared by every Bubble
 * process. A process holding a stale copy used to present an already-rotated
 * refresh token and die with `refresh_token_reused`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodex = vi.fn();
vi.mock("../oauth/openai-codex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../oauth/openai-codex.js")>()),
  refreshOpenAICodex: (...args: unknown[]) => refreshOpenAICodex(...args),
}));

const { ProviderRegistry } = await import("../provider-registry.js");
const { AuthStorage } = await import("../oauth/storage.js");

const REUSED = 'Token refresh failed: 401 Unauthorized - {"error":{"code":"refresh_token_reused"}}';

function emptyConfig() {
  return {
    getProviders: () => [],
    setProviders: () => undefined,
    getDefaultProvider: () => undefined,
    setDefaultProvider: () => undefined,
    getApiKey: () => undefined,
    setApiKey: () => undefined,
    getDefaultModel: () => undefined,
    setDefaultModel: () => undefined,
    getRecentModels: () => [],
    pushRecentModel: () => undefined,
  } as any;
}

const expired = (tag: string) => ({
  type: "oauth" as const,
  accessToken: `access-${tag}`,
  refreshToken: `refresh-${tag}`,
  expiresAt: Date.now() - 60_000,
});
const fresh = (tag: string) => ({ ...expired(tag), expiresAt: Date.now() + 3_600_000 });

describe("OAuth refresh with auth.json shared between processes", () => {
  let home: string;
  let previousHome: string | undefined;
  let authPath: string;

  beforeEach(() => {
    previousHome = process.env.BUBBLE_HOME;
    home = mkdtempSync(join(tmpdir(), "bubble-shared-refresh-"));
    process.env.BUBBLE_HOME = home;
    authPath = join(home, "auth.json");
    refreshOpenAICodex.mockReset();
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.BUBBLE_HOME;
    else process.env.BUBBLE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("adopts a token another process already rotated instead of spending the stale one", async () => {
    new AuthStorage(authPath).set("openai", expired("old"));
    const registry = new ProviderRegistry(emptyConfig());
    const adapter = registry.createOpenAICodexAuthAdapter("openai")!;
    const held = (await adapter.getCredentials())!;

    // Another Bubble process refreshes while this one still holds the old set.
    new AuthStorage(authPath).set("openai", fresh("rotated"));

    const result = await adapter.refreshCredentials(held);
    expect(result.refreshToken).toBe("refresh-rotated");
    expect(refreshOpenAICodex).not.toHaveBeenCalled();
  });

  it("refreshes once and persists without touching other providers' entries", async () => {
    new AuthStorage(authPath).set("openai", expired("old"));
    new AuthStorage(authPath).set("grok", fresh("grok"));
    refreshOpenAICodex.mockResolvedValue({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: Date.now() + 3_600_000,
    });
    const registry = new ProviderRegistry(emptyConfig());

    await registry.prepareProvider("openai");

    expect(refreshOpenAICodex).toHaveBeenCalledTimes(1);
    expect(refreshOpenAICodex).toHaveBeenCalledWith("refresh-old");
    const onDisk = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(onDisk.openai.refreshToken).toBe("refresh-new");
    expect(onDisk.grok.refreshToken).toBe("refresh-grok");
  });

  it("recovers when the rotation lands while our refresh request is in flight", async () => {
    new AuthStorage(authPath).set("openai", expired("old"));
    const registry = new ProviderRegistry(emptyConfig());
    refreshOpenAICodex.mockImplementation(async () => {
      new AuthStorage(authPath).set("openai", fresh("rotated"));
      throw new Error(REUSED);
    });

    await registry.prepareProvider("openai");
    expect(registry.getAuthStorage().get("openai")!.refreshToken).toBe("refresh-rotated");
  });

  it("tells the user to sign in again when the saved token is truly dead", async () => {
    new AuthStorage(authPath).set("openai", expired("dead"));
    const registry = new ProviderRegistry(emptyConfig());
    refreshOpenAICodex.mockRejectedValue(new Error(REUSED));

    await expect(registry.prepareProvider("openai")).rejects.toThrow(/Run \/login openai to sign in again/);
    // The dead entry is kept: removing it is the user's call via /logout.
    expect(registry.getAuthStorage().has("openai")).toBe(true);
  });

  it("still performs a forced refresh when nobody else rotated the token", async () => {
    new AuthStorage(authPath).set("openai", fresh("current"));
    refreshOpenAICodex.mockResolvedValue({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: Date.now() + 3_600_000,
    });
    const registry = new ProviderRegistry(emptyConfig());
    const adapter = registry.createOpenAICodexAuthAdapter("openai")!;

    // Provider got a 401 on an unexpired token and forces a refresh.
    const result = await adapter.refreshCredentials((await adapter.getCredentials())!);
    expect(refreshOpenAICodex).toHaveBeenCalledTimes(1);
    expect(result.refreshToken).toBe("refresh-new");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry, displayModel, isUserVisibleProvider, normalizeModel, type ProviderProfile } from "../provider-registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider registry", () => {
  it("normalizes provider-less models to openai by default", () => {
    expect(normalizeModel("gpt-4o")).toBe("openai:gpt-4o");
  });

  it("uses built-in display names for encoded models", () => {
    expect(displayModel("fireworks:accounts/fireworks/models/kimi-k2p6")).toBe("Kimi-K2.6");
    expect(displayModel("alibaba:qwen3.7-max")).toBe("Qwen3.7 Max");
    expect(displayModel("stepfun:step-3.7-flash")).toBe("Step 3.7 Flash");
    expect(displayModel("minimax:MiniMax-M3")).toBe("MiniMax M3");
    expect(displayModel("minimax-anthropic:MiniMax-M3")).toBe("MiniMax M3");
    expect(displayModel("doubao:doubao-seed-2-1-pro-260628")).toBe("Doubao Seed 2.1 Pro");
    expect(displayModel("anthropic:claude-fable-5")).toBe("Claude Fable 5");
    expect(displayModel("anthropic:claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(displayModel("opencode-zen:muse-spark-1.3-contributor-free")).toBe("Muse Spark 1.3 Free");
  });

  it("shows Doubao as a user-visible provider", () => {
    expect(isUserVisibleProvider("doubao")).toBe(true);
  });

  it("shows OpenRouter as a user-visible provider", () => {
    expect(isUserVisibleProvider("openrouter")).toBe(true);
  });

  it("shows the OpenCode Zen Muse provider", () => {
    expect(isUserVisibleProvider("opencode-zen")).toBe(true);
  });

  it("exposes MiniMax Token Plan and MiniMax API as visible providers", () => {
    expect(isUserVisibleProvider("minimax")).toBe(true);
    expect(isUserVisibleProvider("minimax-anthropic")).toBe(true);
  });

  it("honors OpenRouter as the configured default provider", () => {
    const providers = [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "or-key",
        enabled: true,
        authType: "api",
      },
      {
        id: "openai",
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        apiKey: "oa-key",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "openrouter",
      setDefaultProvider: () => undefined,
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultModel: () => undefined,
      getRecentModels: () => [],
      pushRecentModel: () => undefined,
    } as any;

    const registry = new ProviderRegistry(config);
    expect(registry.getDefault()?.id).toBe("openrouter");
  });

  it("overlays built-in protocol metadata onto configured providers", () => {
    const providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "sk-ant",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "anthropic",
      setDefaultProvider: () => undefined,
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultModel: () => undefined,
      getRecentModels: () => [],
      pushRecentModel: () => undefined,
    } as any;

    const registry = new ProviderRegistry(config);
    expect(registry.getDefault()).toMatchObject({
      id: "anthropic",
      protocol: "anthropic-messages",
    });
  });

  it("upgrades google profiles stored with the legacy OpenAI-compat baseURL", () => {
    const makeConfig = (baseURL: string) => ({
      getProviders: () => [{
        id: "google",
        name: "Google",
        baseURL,
        apiKey: "g-key",
        enabled: true,
        authType: "api",
      }],
      setProviders: () => undefined,
      getDefaultProvider: () => "google",
      setDefaultProvider: () => undefined,
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultModel: () => undefined,
      getRecentModels: () => [],
      pushRecentModel: () => undefined,
    }) as any;

    // Stale profile captured from the pre-ai-sdk builtin default: follows the
    // builtin to the native endpoint and picks up the ai-sdk protocol.
    const legacy = new ProviderRegistry(makeConfig("https://generativelanguage.googleapis.com/v1beta/openai"));
    expect(legacy.getDefault()).toMatchObject({
      id: "google",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      protocol: "ai-sdk",
    });

    // A genuinely custom URL stays untouched and keeps the openai-chat fallback.
    const custom = new ProviderRegistry(makeConfig("https://my-proxy.example.com/v1beta/openai"));
    const customProfile = custom.getDefault();
    expect(customProfile?.baseURL).toBe("https://my-proxy.example.com/v1beta/openai");
    expect(customProfile?.protocol).toBeUndefined();
  });

  it("overlays Ark Responses protocol metadata onto configured Doubao providers", () => {
    const providers = [
      {
        id: "doubao",
        name: "Doubao",
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "ark-key",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "doubao",
      setDefaultProvider: () => undefined,
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultModel: () => undefined,
      getRecentModels: () => [],
      pushRecentModel: () => undefined,
    } as any;

    const registry = new ProviderRegistry(config);
    expect(registry.getDefault()).toMatchObject({
      id: "doubao",
      protocol: "ark-responses",
    });
  });

  it("does not force Anthropic protocol onto MiniMax OpenAI-compatible overrides", () => {
    const providers = [
      {
        id: "minimax",
        name: "MiniMax",
        baseURL: "https://api.minimaxi.com/v1",
        apiKey: "sk-cp",
        enabled: true,
        authType: "api",
      },
    ];
    const config = {
      getProviders: () => providers.slice(),
      setProviders: () => undefined,
      getDefaultProvider: () => "minimax",
      setDefaultProvider: () => undefined,
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      getDefaultModel: () => undefined,
      setDefaultModel: () => undefined,
      getRecentModels: () => [],
      pushRecentModel: () => undefined,
    } as any;

    const registry = new ProviderRegistry(config);
    expect(registry.getDefault()).toMatchObject({
      id: "minimax",
      baseURL: "https://api.minimaxi.com/v1",
    });
    expect(registry.getDefault()?.protocol).toBeUndefined();
  });

  it("deduplicates in-flight discovery and reuses the successful memory cache", async () => {
    const registry = new ProviderRegistry(emptyConfig());
    const provider = openRouterProfile("key-a");
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = registry.discoverModels(provider);
    const duplicate = registry.discoverModels(provider);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse({ data: [
      { id: "model-a", name: "Model A" },
      {
        id: "stealth/ox-alpha",
        name: "Ox Alpha Remote",
        context_length: 1048576,
        supported_parameters: ["reasoning", "tools"],
        reasoning: {
          mandatory: true,
          supported_efforts: ["max", "high", "low"],
          default_effort: "max",
        },
      },
    ] }));
    await expect(first).resolves.toMatchObject({ source: "remote", authoritative: true });
    await expect(duplicate).resolves.toMatchObject({ source: "remote", authoritative: true });

    await expect(registry.discoverModels(provider)).resolves.toMatchObject({
      source: "cache",
      authoritative: true,
      models: [expect.objectContaining({
        id: "stealth/ox-alpha",
        name: "Ox Alpha Remote",
        providerId: "openrouter",
        contextWindow: 1048576,
        reasoningLevels: ["low", "high", "max"],
        defaultReasoningLevel: "max",
      })],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the static Ox reasoning contract when remote metadata is malformed", async () => {
    const registry = new ProviderRegistry(emptyConfig());
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{
      id: "stealth/ox-alpha",
      name: "Ox Alpha Live",
      context_length: "not-a-number",
      reasoning: {
        mandatory: true,
        supported_efforts: ["none", "unsupported"],
        default_effort: "none",
      },
    }] })));

    await expect(registry.discoverModels(openRouterProfile("key-a"))).resolves.toMatchObject({
      source: "remote",
      authoritative: true,
      models: [expect.objectContaining({
        id: "stealth/ox-alpha",
        name: "Ox Alpha Live",
        contextWindow: 1048576,
        reasoningLevels: ["low", "high", "max"],
        defaultReasoningLevel: "max",
      })],
    });
  });

  it("isolates discovery by credential identity and rejects an older generation", async () => {
    const registry = new ProviderRegistry(emptyConfig());
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    })));

    const oldRequest = registry.discoverModels(openRouterProfile("key-a"));
    const newRequest = registry.discoverModels(openRouterProfile("key-b"));
    expect(resolvers).toHaveLength(2);

    resolvers[1](jsonResponse({ data: [{ id: "stealth/ox-alpha", name: "Current Ox" }] }));
    await expect(newRequest).resolves.toMatchObject({
      source: "remote",
      models: [expect.objectContaining({ id: "stealth/ox-alpha", name: "Current Ox" })],
    });

    resolvers[0](jsonResponse({ data: [{ id: "stealth/ox-alpha", name: "Stale Ox" }] }));
    await expect(oldRequest).resolves.toMatchObject({
      source: "fallback",
      authoritative: false,
      error: "Model catalog changed while it was refreshing.",
    });
  });

  it("returns an explicit fallback status and briefly caches discovery failures", async () => {
    const registry = new ProviderRegistry(emptyConfig());
    const provider = openRouterProfile("failing-key");
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(registry.discoverModels(provider)).resolves.toMatchObject({
      source: "fallback",
      authoritative: false,
      error: "network unavailable",
    });
    await expect(registry.discoverModels(provider)).resolves.toMatchObject({
      source: "cache",
      authoritative: false,
      error: "network unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

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

function openRouterProfile(apiKey: string): ProviderProfile {
  return {
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    enabled: true,
    authType: "api",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

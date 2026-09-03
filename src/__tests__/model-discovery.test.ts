/**
 * Generic OpenAI-compatible /models discovery.
 *
 * Vendor catalogs probed 2026-08-04 are neither complete nor clean: zhipuai
 * omits glm-5.2, stepfun omits step-3.7-flash (both usable), kimi-for-coding
 * ships ids that share nothing with the builtin list, alibaba returns 236
 * entries including image/audio models, fireworks 412s. Discovery therefore
 * augments the curated catalog rather than replacing it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderRegistry,
  isLikelyChatModelId,
  isOpenAICompatibleProtocol,
  type ProviderProfile,
} from "../provider-registry.js";
import { clearDynamicModelMetadata, getBuiltinModel } from "../model-catalog.js";
import type { UserConfig } from "../config.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeUserConfig(providers: ProviderProfile[]): UserConfig {
  return {
    getProviders: () => providers.slice(),
    setProviders: () => undefined,
    getDefaultProvider: () => undefined,
    setDefaultProvider: () => undefined,
  } as unknown as UserConfig;
}

function isolatedRegistry(providers: ProviderProfile[]): ProviderRegistry {
  const registry = new ProviderRegistry(fakeUserConfig(providers));
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

function stubModelsResponse(ids: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const stepfun: ProviderProfile = {
  id: "stepfun",
  name: "StepFun",
  baseURL: "https://api.stepfun.com/step_plan/v1",
  apiKey: "sk-test",
  enabled: true,
};

describe("OpenAI-compatible model discovery", () => {
  it("merges newly-added curated models into a stale non-authoritative cache", async () => {
    const provider: ProviderProfile = {
      id: "zhipuai-coding-plan",
      name: "Zhipu AI Coding Plan",
      baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: "sk-test",
      enabled: true,
    };
    const registry = isolatedRegistry([provider]);
    const key = (registry as any).modelDiscoveryKey(provider);
    (registry as any).modelDiscoveryCache.set(key, {
      result: {
        models: [{ id: "glm-5.2", name: "GLM-5.2", providerId: provider.id }],
        source: "remote",
        authoritative: false,
      },
      expiresAt: Date.now() + 60_000,
      identityKey: "stale",
      providerId: provider.id,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry.discoverModels(provider);

    expect(result.source).toBe("cache");
    expect(result.models).toContainEqual(expect.objectContaining({
      id: "glm-5.3-flash",
      tier: "fast",
      contextWindow: 1_000_000,
      reasoningLevels: ["low", "high", "max"],
      defaultReasoningLevel: "max",
    }));
    expect(result.models.map((model) => model.id)).toContain("glm-5.3");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds remote-only models to the curated catalog", async () => {
    stubModelsResponse(["step-3.5-flash", "step-9-future"]);
    const registry = isolatedRegistry([stepfun]);

    const result = await registry.discoverModels(stepfun);
    const ids = result.models.map((model) => model.id);

    expect(ids).toContain("step-9-future");
    // Curated entries the vendor list omits must survive (this one is usable
    // and priced despite never appearing in /models).
    expect(ids).toContain("step-3.7-flash");
    // Union membership is not a closed allowlist.
    expect(result.authoritative).toBe(false);
  });

  it("keeps curated metadata for ids present in both lists", async () => {
    stubModelsResponse(["step-3.7-flash"]);
    const registry = isolatedRegistry([stepfun]);

    const result = await registry.discoverModels(stepfun);
    const curated = result.models.filter((model) => model.id === "step-3.7-flash");

    expect(curated).toHaveLength(1);
    expect(curated[0].reasoningLevels?.length).toBeGreaterThan(0);
  });

  it("filters non-chat modalities out of noisy vendor catalogs", async () => {
    stubModelsResponse(["chat-next", "qwen-image-3.0", "text-embedding-v4", "cosyvoice-tts", "paraformer-asr"]);
    const alibaba: ProviderProfile = {
      id: "alibaba",
      name: "Alibaba",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "sk-test",
      enabled: true,
    };
    const registry = isolatedRegistry([alibaba]);

    const ids = (await registry.discoverModels(alibaba)).models.map((m) => m.id);

    expect(ids).toContain("chat-next");
    expect(ids).not.toContain("qwen-image-3.0");
    expect(ids).not.toContain("text-embedding-v4");
    expect(ids).not.toContain("cosyvoice-tts");
    expect(ids).not.toContain("paraformer-asr");
  });

  it("falls back to the curated catalog when /models fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 412 })));
    const registry = isolatedRegistry([stepfun]);

    const result = await registry.discoverModels(stepfun);

    expect(result.source).toBe("static");
    expect(result.models.map((m) => m.id)).toContain("step-3.7-flash");
  });

  it("does not probe providers without an API key", async () => {
    const fetchMock = stubModelsResponse(["whatever"]);
    const registry = isolatedRegistry([{ ...stepfun, apiKey: "" }]);

    await registry.discoverModels({ ...stepfun, apiKey: "" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies protocols and model ids", () => {
    expect(isOpenAICompatibleProtocol(undefined)).toBe(true);
    expect(isOpenAICompatibleProtocol("openai-chat")).toBe(true);
    expect(isOpenAICompatibleProtocol("openai-responses")).toBe(false);
    expect(isOpenAICompatibleProtocol("anthropic-messages")).toBe(false);
    expect(isOpenAICompatibleProtocol("ark-responses")).toBe(false);

    expect(isLikelyChatModelId("kimi-k3")).toBe(true);
    expect(isLikelyChatModelId("moonshot-v1-128k-vision-preview")).toBe(true);
    expect(isLikelyChatModelId("qwen-image-3.0-pro")).toBe(false);
    expect(isLikelyChatModelId("text-embedding-3-large")).toBe(false);
  });
});

describe("Gemini model discovery cache", () => {
  it("recomputes locally-derived reasoning levels when an old disk cache is restored", async () => {
    const previousBubbleHome = process.env.BUBBLE_HOME;
    const previousVitest = process.env.VITEST;
    const bubbleHome = mkdtempSync(join(tmpdir(), "bubble-gemini-cache-"));
    const provider: ProviderProfile = {
      id: "google",
      name: "Google Gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      enabled: true,
      protocol: "ai-sdk",
    };

    try {
      process.env.BUBBLE_HOME = bubbleHome;
      // Build the identity-aware key without loading disk state first.
      process.env.VITEST = "true";
      const probe = isolatedRegistry([provider]);
      const key = (probe as any).modelDiscoveryKey(provider);
      writeFileSync(join(bubbleHome, "model-discovery-cache.json"), JSON.stringify({
        [key]: {
          result: {
            models: [{
              id: "gemini-3.8-flash",
              name: "Gemini 3.8 Flash",
              providerId: "google",
              reasoningLevels: ["minimal", "low", "medium", "high"],
              contextWindow: 1_048_576,
            }],
            source: "remote",
            authoritative: true,
          },
          expiresAt: Date.now() + 60_000,
          identityKey: "old-build",
          providerId: "google",
          protocol: "ai-sdk",
        },
      }));

      clearDynamicModelMetadata("google");
      process.env.VITEST = "false";
      const registry = isolatedRegistry([provider]);

      // Startup overlay is already corrected before /model is opened.
      expect(getBuiltinModel("google", "gemini-3.8-flash")?.reasoningLevels)
        .toEqual(["off", "low", "medium", "high"]);

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await registry.discoverModels(provider);
      expect(result.source).toBe("cache");
      expect(result.models[0]?.reasoningLevels).toEqual(["off", "low", "medium", "high"]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      clearDynamicModelMetadata("google");
      rmSync(bubbleHome, { recursive: true, force: true });
      if (previousBubbleHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previousBubbleHome;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
    }
  });
});

describe("grok subscription discovery", () => {
  const grokProvider: ProviderProfile = {
    id: "grok",
    name: "Grok Subscription",
    baseURL: "https://cli-chat-proxy.grok.com/v1",
    apiKey: "",
    enabled: true,
  };

  it("surfaces remote-only models through the refreshing subscription fetch", async () => {
    const previousProxy = process.env.BUBBLE_SYSTEM_PROXY;
    process.env.BUBBLE_SYSTEM_PROXY = "0";
    try {
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/models");
        const headers = new Headers(init?.headers);
        expect(headers.get("user-agent")).toBe("grok-cli");
        expect(headers.get("x-grok-client-version")).toBe("0.2.93");
        expect(headers.get("authorization")).toBe("Bearer access-token");
        return new Response(JSON.stringify({ data: [
          { id: "grok-4.5" },
          { id: "grok-5-next", name: "Grok 5" },
        ] }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const registry = isolatedRegistry([grokProvider]);
      registry.getAuthStorage().set("grok", {
        type: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      const configured = registry.getConfigured().find((provider) => provider.id === "grok");
      expect(configured?.authType).toBe("oauth");

      const result = await registry.discoverModels(configured!);
      const ids = result.models.map((model) => model.id);

      expect(result.authoritative).toBe(true);
      // Curated entries survive even when the remote list omits them.
      expect(ids).toContain("grok-4.5");
      expect(ids).toContain("grok-composer-2.5-fast");
      // A newly-released remote-only model is surfaced without a code change.
      expect(ids).toContain("grok-5-next");
      // Its metadata lands in the dynamic overlay for routing/picker lookups.
      expect(getBuiltinModel("grok", "grok-5-next")?.name).toBe("Grok 5");
      // A flagship grok-N.M id infers the same ladder as curated grok-4.5, so it
      // is selectable with low/medium/high effort instead of being skipped.
      expect(getBuiltinModel("grok", "grok-5-next")?.reasoningLevels).toEqual(["low", "medium", "high"]);
      expect(getBuiltinModel("grok", "grok-5-next")?.defaultReasoningLevel).toBe("high");
      expect(getBuiltinModel("grok", "grok-5-next")?.contextWindow).toBe(500000);
    } finally {
      process.env.BUBBLE_SYSTEM_PROXY = previousProxy;
      vi.unstubAllGlobals();
    }
  });
});

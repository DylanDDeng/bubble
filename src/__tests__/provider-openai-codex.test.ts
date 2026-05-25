import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAICodexPromptCacheKey,
  createOpenAICodexProvider,
  extractChatGptAccountId,
  getOpenAICodexFallbackModels,
  isOpenAICodexBaseUrl,
  normalizeOpenAICodexUsage,
  sortCodexModelDescriptors,
} from "../provider-openai-codex.js";

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

describe("provider-openai-codex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes the ChatGPT Codex backend base URL", () => {
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("extracts the chatgpt account id from the access token", () => {
    const token = `header.${encodePayload({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
      },
    })}.sig`;

    expect(extractChatGptAccountId(token)).toBe("account-123");
  });

  it("returns the latest fallback model first", () => {
    expect(getOpenAICodexFallbackModels()[0]).toBe("gpt-5.4");
  });

  it("maps Responses cached input tokens into prompt cache usage", () => {
    expect(normalizeOpenAICodexUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 120,
    })).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      promptCacheHitTokens: 40,
      promptCacheMissTokens: 60,
      reasoningTokens: 12,
      totalTokens: 120,
    });
  });

  it("builds stable opaque prompt cache keys by provider and model", () => {
    const a = buildOpenAICodexPromptCacheKey({
      seed: "session-secret",
      providerId: "openai-codex",
      model: "gpt-5.4",
    });
    const b = buildOpenAICodexPromptCacheKey({
      seed: "session-secret",
      providerId: "openai-codex",
      model: "gpt-5.4",
    });
    const differentModel = buildOpenAICodexPromptCacheKey({
      seed: "session-secret",
      providerId: "openai-codex",
      model: "gpt-5.4-mini",
    });

    expect(a).toBe(b);
    expect(a).not.toBe(differentModel);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain("session-secret");
  });

  it("sends the persistent prompt cache key and forwards cached usage from streams", async () => {
    const token = `header.${encodePayload({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
      },
    })}.sig`;
    const encoder = new TextEncoder();
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 100,
              input_tokens_details: { cached_tokens: 25 },
              output_tokens: 10,
              total_tokens: 110,
            },
          },
        })}\n\n`));
        controller.close();
      },
    });
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInits.push(init ?? {});
      return new Response(responseBody, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
      promptCacheKey: "session-secret",
    });
    const chunks = [];
    for await (const chunk of provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.4" })) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(requestInits[0].body));
    expect(body.prompt_cache_key).toBe(buildOpenAICodexPromptCacheKey({
      seed: "session-secret",
      providerId: "openai-codex",
      model: "gpt-5.4",
    }));
    expect(chunks).toContainEqual({
      type: "usage",
      usage: {
        promptTokens: 100,
        completionTokens: 10,
        promptCacheHitTokens: 25,
        promptCacheMissTokens: 75,
        reasoningTokens: undefined,
        totalTokens: 110,
      },
    });
  });

  it("sorts models by family version desc, floating new families above catalog entries", () => {
    // shuffled input; gpt-5.5 isn't in the static catalog yet
    const sorted = sortCodexModelDescriptors([
      { id: "gpt-5.4-mini" },
      { id: "gpt-5.2" },
      { id: "gpt-5.4" },
      { id: "gpt-5.5" },
      { id: "gpt-5.3-codex" },
    ]).map((d) => d.id);

    expect(sorted[0]).toBe("gpt-5.5");
    expect(sorted.indexOf("gpt-5.4")).toBeLessThan(sorted.indexOf("gpt-5.4-mini"));
    expect(sorted.indexOf("gpt-5.4-mini")).toBeLessThan(sorted.indexOf("gpt-5.3-codex"));
    expect(sorted[sorted.length - 1]).toBe("gpt-5.2");
  });
});

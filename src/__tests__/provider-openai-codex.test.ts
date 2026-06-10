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
import type { OAuthCredentials } from "../oauth/types.js";
import type { ToolDefinition } from "../types.js";

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function makeAccessToken(accountId: string): string {
  return `header.${encodePayload({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  })}.sig`;
}

function makeSseResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        },
      })}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
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
    const token = makeAccessToken("account-123");

    expect(extractChatGptAccountId(token)).toBe("account-123");
  });

  it("returns the latest fallback model first", () => {
    expect(getOpenAICodexFallbackModels()[0]).toBe("gpt-5.5");
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
    const token = makeAccessToken("account-123");
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
    const headers = new Headers(requestInits[0].headers);
    expect(body.prompt_cache_key).toBe(buildOpenAICodexPromptCacheKey({
      seed: "session-secret",
      providerId: "openai-codex",
      model: "gpt-5.4",
    }));
    expect(headers.get("session_id")).toBeTruthy();
    expect(headers.get("session_id")).not.toBe("session-secret");
    expect(headers.get("session-id")).toBeNull();
    expect(headers.get("x-session-affinity")).toBeNull();
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

  it("preserves Codex tools while disabling tool calls", async () => {
    const token = makeAccessToken("account-123");
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInits.push(init ?? {});
      return makeSseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const readTool: ToolDefinition = {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };
    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
    });

    await collectStream(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "gpt-5.4",
      tools: [readTool],
      toolChoice: "none",
    }));

    const body = JSON.parse(String(requestInits[0].body));
    expect(body.tools?.map((tool: any) => tool.name)).toEqual(["read"]);
    expect(body.tool_choice).toBe("none");
  });

  it("refreshes OAuth credentials before Codex requests and deduplicates concurrent refreshes", async () => {
    const oldToken = makeAccessToken("account-old");
    const newToken = makeAccessToken("account-new");
    let credentials: OAuthCredentials = {
      type: "oauth",
      accessToken: oldToken,
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 1000,
      accountId: "account-old",
    };
    let resolveRefresh: (() => void) | undefined;
    const refreshReady = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshCredentials = vi.fn(async () => {
      await refreshReady;
      credentials = {
        type: "oauth",
        accessToken: newToken,
        refreshToken: "refresh-new",
        expiresAt: Date.now() + 60 * 60 * 1000,
        accountId: "account-new",
      };
      return credentials;
    });
    const authHeaders: string[] = [];
    const accountHeaders: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get("Authorization") || "");
      accountHeaders.push(headers.get("ChatGPT-Account-Id") || "");
      return makeSseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: oldToken,
      baseURL: "https://chatgpt.com/backend-api",
      auth: {
        getCredentials: () => credentials,
        refreshCredentials,
      },
    });

    const first = collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" }));
    const second = collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" }));

    await waitFor(() => refreshCredentials.mock.calls.length === 1);
    resolveRefresh?.();
    await Promise.all([first, second]);

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(authHeaders).toEqual([`Bearer ${newToken}`, `Bearer ${newToken}`]);
    expect(accountHeaders).toEqual(["account-new", "account-new"]);
  });

  it("forces refresh and retries once when Codex returns token_expired", async () => {
    const oldToken = makeAccessToken("account-old");
    const newToken = makeAccessToken("account-new");
    let credentials: OAuthCredentials = {
      type: "oauth",
      accessToken: oldToken,
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-old",
    };
    const refreshCredentials = vi.fn(async () => {
      credentials = {
        type: "oauth",
        accessToken: newToken,
        refreshToken: "refresh-new",
        expiresAt: Date.now() + 60 * 60 * 1000,
        accountId: "account-new",
      };
      return credentials;
    });
    const authHeaders: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get("Authorization") || "");
      if (authHeaders.length === 1) {
        return new Response(JSON.stringify({
          detail: {
            code: "token_expired",
            message: "Your ChatGPT session expired before this request finished.",
          },
        }), { status: 401 });
      }
      return makeSseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: oldToken,
      baseURL: "https://chatgpt.com/backend-api",
      auth: {
        getCredentials: () => credentials,
        refreshCredentials,
      },
    });

    await collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" }));

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(authHeaders).toEqual([`Bearer ${oldToken}`, `Bearer ${newToken}`]);
  });

  it("retries a transient transport failure before any SSE event is parsed", async () => {
    const token = makeAccessToken("account-123");
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw new Error("The socket connection was closed unexpectedly.");
      }
      return makeSseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
    });

    const chunks = await collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({ type: "done" });
  });

  it("retries a certificate verification failure before any SSE event is parsed", async () => {
    const token = makeAccessToken("account-123");
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw new Error("unknown certificate verification error");
      }
      return makeSseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
    });

    const chunks = await collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({ type: "done" });
  });

  it("retries Bun connection failures before any SSE event is parsed", async () => {
    const token = makeAccessToken("account-123");
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      }
      return makeSseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
    });

    const chunks = await collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({ type: "done" });
  });

  it("retries when the SSE body errors before a parsed event", async () => {
    const token = makeAccessToken("account-123");
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("fetch failed: UND_ERR_SOCKET"));
          },
        }), { status: 200 });
      }
      return makeSseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
    });

    await collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry transport failures after any SSE event is parsed", async () => {
    const token = makeAccessToken("account-123");
    const encoder = new TextEncoder();
    let emitted = false;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "started",
        })}\n\n`));
        emitted = true;
      },
      pull(controller) {
        if (emitted) {
          controller.error(new Error("The socket connection was closed unexpectedly."));
        }
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
    });

    await expect(collectStream(provider.streamChat([{ role: "user", content: "hi" }], { model: "gpt-5.5" })))
      .rejects.toThrow(/socket connection/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry transport failures when the request has been aborted", async () => {
    const token = makeAccessToken("account-123");
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    const fetchMock = vi.fn(async () => {
      throw new Error("The socket connection was closed unexpectedly.");
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICodexProvider({
      providerId: "openai-codex",
      apiKey: token,
      baseURL: "https://chatgpt.com/backend-api",
    });

    await expect(collectStream(provider.streamChat(
      [{ role: "user", content: "hi" }],
      { model: "gpt-5.5", abortSignal: controller.signal },
    ))).rejects.toThrow(/socket connection/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sorts models by family version desc, floating new families above catalog entries", () => {
    // shuffled input; gpt-5.6 represents a newly returned family before the
    // static fallback catalog has been updated.
    const sorted = sortCodexModelDescriptors([
      { id: "gpt-5.4-mini" },
      { id: "gpt-5.2" },
      { id: "gpt-5.4" },
      { id: "gpt-5.6" },
      { id: "gpt-5.3-codex" },
    ]).map((d) => d.id);

    expect(sorted[0]).toBe("gpt-5.6");
    expect(sorted.indexOf("gpt-5.4")).toBeLessThan(sorted.indexOf("gpt-5.4-mini"));
    expect(sorted.indexOf("gpt-5.4-mini")).toBeLessThan(sorted.indexOf("gpt-5.3-codex"));
    expect(sorted[sorted.length - 1]).toBe("gpt-5.2");
  });
});

async function waitFor(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

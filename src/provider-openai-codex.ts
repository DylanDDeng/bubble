import { createHash } from "node:crypto";
import type { Provider, ProviderMessage, ReasoningEffort, StreamChunk, ThinkingLevel, TokenUsage, ToolDefinition } from "./types.js";
import type { OAuthCredentials } from "./oauth/types.js";
import { listBuiltinModels } from "./model-catalog.js";
import { resolveProviderRequestConfig } from "./provider-transform.js";
import {
  chatGptFetch,
  classifyChatGptNetworkError,
  getChatGptProxyForUrl,
  getChatGptNetworkDiagnostics,
  hasChatGptProxyEnv,
  type ChatGptFetch,
} from "./network/chatgpt-transport.js";
import { summarizeTraceError, traceEvent } from "./debug-trace.js";

export interface CodexModelDescriptor {
  id: string;
  displayName?: string;
  contextWindow?: number;
  reasoningLevels?: ReasoningEffort[];
  visibility?: string;
  minimalClientVersion?: string;
  /** Server-declared per-tool-output token cap (truncation_policy.limit when mode=tokens). */
  toolOutputTokenLimit?: number;
}

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES = "responses=experimental";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const TOKEN_REFRESH_GRACE_MS = 5 * 60 * 1000;
const CODEX_TRANSPORT_MAX_RETRIES = 2;
const CODEX_TRANSPORT_RETRY_BASE_DELAY_MS = 250;
const CODEX_SSE_HEADER_TIMEOUT_MS = 10_000;
const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// OpenAI gates new codex models server-side by client_version (each model carries a
// `minimal_client_version`). Track a recent real Codex CLI release; override via env
// when OpenAI lifts the gate again before we cut a new release.
const CODEX_CLIENT_VERSION = process.env.BUBBLE_CODEX_CLIENT_VERSION?.trim() || "0.150.0";
const MODEL_DISCOVERY_PATHS = [
  `/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
  "/models",
];

export type OpenAICodexTransport = "auto" | "sse" | "websocket";

export function isOpenAICodexBaseUrl(baseURL: string): boolean {
  const normalized = baseURL.trim().replace(/\/+$/, "");
  return normalized === DEFAULT_CODEX_BASE_URL || normalized.startsWith(`${DEFAULT_CODEX_BASE_URL}/`);
}

export function getOpenAICodexFallbackModels(): string[] {
  return listBuiltinModels("openai-codex").map((model) => model.id);
}

export interface OpenAICodexAuthAdapter {
  getCredentials: () => OAuthCredentials | undefined | Promise<OAuthCredentials | undefined>;
  refreshCredentials: (current?: OAuthCredentials) => Promise<OAuthCredentials>;
  isExpired?: (credentials: OAuthCredentials, graceMs: number) => boolean;
}

export function extractChatGptAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, any>;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id) {
      return auth.chatgpt_account_id;
    }
    if (typeof auth?.account_id === "string" && auth.account_id) {
      return auth.account_id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function createOpenAICodexProvider(options: {
  providerId?: string;
  apiKey: string;
  baseURL: string;
  thinkingLevel?: ThinkingLevel;
  promptCacheKey?: string;
  auth?: OpenAICodexAuthAdapter;
  fetch?: ChatGptFetch;
  transport?: OpenAICodexTransport;
}): Provider {
  const sessionId = createCodexSessionId();
  const fetchImpl = options.fetch ?? chatGptFetch;
  let refreshPromise: Promise<OAuthCredentials> | undefined;

  async function resolveRequestAuth(forceRefresh = false): Promise<{ accessToken: string; accountId: string }> {
    let credentials = await options.auth?.getCredentials();
    if (credentials && options.auth) {
      const expired = options.auth.isExpired
        ? options.auth.isExpired(credentials, TOKEN_REFRESH_GRACE_MS)
        : Date.now() >= credentials.expiresAt - TOKEN_REFRESH_GRACE_MS;
      if ((forceRefresh || !credentials.accessToken || expired) && credentials.refreshToken) {
        if (!refreshPromise) {
          refreshPromise = options.auth.refreshCredentials(credentials).finally(() => {
            refreshPromise = undefined;
          });
        }
        credentials = await refreshPromise;
      }
    }

    const accessToken = credentials?.accessToken || options.apiKey;
    const accountId = credentials?.accountId || extractChatGptAccountId(accessToken);
    if (!accountId) {
      throw new Error("Failed to extract chatgpt_account_id from ChatGPT OAuth token.");
    }
    return { accessToken, accountId };
  }

  async function* streamChat(
    messages: ProviderMessage[],
    chatOptions: { model: string; tools?: ToolDefinition[]; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal }
  ): AsyncIterable<StreamChunk> {
    const requestConfig = resolveProviderRequestConfig(
      "openai-codex",
      chatOptions.model,
      chatOptions.thinkingLevel ?? options.thinkingLevel ?? "off",
    );
    const requestBody = buildRequestBody(messages, {
      model: chatOptions.model,
      tools: chatOptions.tools,
      reasoningEffort: requestConfig.reasoningEffort,
      sessionId,
      providerId: options.providerId,
      promptCacheKey: options.promptCacheKey,
    });
    const body = JSON.stringify(requestBody);
    const requestId = createCodexRequestId();
    const requestedTransport = resolveOpenAICodexTransport(options.transport);
    let activeTransport = initialCodexTransport(requestedTransport, sessionId);
    let sseAttempt = 0;

    for (;;) {
      let sawTransportEvent = false;
      let sawResponseEvent = false;
      const toolCallState: CodexToolCallState = {};
      try {
        const events = activeTransport === "websocket"
          ? streamWebSocketEvents({
              requestBody,
              baseURL: options.baseURL,
              sessionId,
              requestId,
              signal: chatOptions.abortSignal,
              resolveAuth: resolveRequestAuth,
            })
          : streamSseEvents({
              body,
              baseURL: options.baseURL,
              sessionId,
              requestId,
              signal: chatOptions.abortSignal,
              fetchImpl,
              resolveAuth: resolveRequestAuth,
            });

        for await (const event of events) {
          sawTransportEvent = true;
          if (isCodexResponseEvent(event)) {
            sawResponseEvent = true;
          }
          for (const chunk of translateCodexEvent(event, toolCallState)) {
            yield chunk;
          }
        }

        yield { type: "done" };
        return;
      } catch (error) {
        if (shouldFallbackCodexWebSocket({
          error,
          requestedTransport,
          activeTransport,
          sawResponseEvent,
          signal: chatOptions.abortSignal,
        })) {
          recordWebSocketSseFallback(sessionId, error);
          traceCodexTransportFailure({
            error,
            model: chatOptions.model,
            transport: activeTransport,
            fallbackTransport: "sse",
            phase: "before_message_stream_start",
            url: resolveCodexWebSocketUrl(options.baseURL),
          });
          activeTransport = "sse";
          continue;
        }

        if (activeTransport === "sse" && shouldRetryCodexTransportError({
          error,
          attempt: sseAttempt,
          sawParsedSseEvent: sawTransportEvent,
          signal: chatOptions.abortSignal,
        })) {
          const delayMs = codexRetryDelayMs(sseAttempt);
          traceEvent("provider_transport_retry", {
            providerId: options.providerId ?? "openai-codex",
            model: chatOptions.model,
            transport: activeTransport,
            attempt: sseAttempt + 1,
            maxRetries: CODEX_TRANSPORT_MAX_RETRIES,
            delayMs,
            failureKind: classifyChatGptNetworkError(error),
            network: getChatGptNetworkDiagnostics(resolveCodexUrl(options.baseURL)),
            error: summarizeTraceError(error),
          });
          sseAttempt += 1;
          await sleepBeforeCodexRetry(delayMs, chatOptions.abortSignal);
          continue;
        }

        traceCodexTransportFailure({
          error,
          model: chatOptions.model,
          transport: activeTransport,
          phase: sawResponseEvent ? "after_message_stream_start" : "before_message_stream_start",
          url: activeTransport === "websocket" ? resolveCodexWebSocketUrl(options.baseURL) : resolveCodexUrl(options.baseURL),
        });
        throw error;
      }
    }
  }

  async function* streamSseEvents(input: {
    body: string;
    baseURL: string;
    sessionId: string;
    requestId: string;
    signal?: AbortSignal;
    fetchImpl: ChatGptFetch;
    resolveAuth: (forceRefresh?: boolean) => Promise<{ accessToken: string; accountId: string }>;
  }): AsyncIterable<Record<string, unknown>> {
    const sendRequest = async (forceRefresh = false) => {
      const { accessToken, accountId } = await input.resolveAuth(forceRefresh);
      const url = resolveCodexUrl(input.baseURL);
      return fetchWithSseHeaderTimeout(input.fetchImpl, url, buildCodexRequestInit({
        accessToken,
        accountId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        signal: input.signal,
        body: input.body,
      }));
    };

    let response = await sendRequest();

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      if (response.status === 401 && options.auth && isTokenExpiredError(errorText)) {
        response = await sendRequest(true);
      } else {
        throw new CodexApiError(`${response.status} status code${errorText ? `: ${errorText}` : " (no body)"}`, {
          status: response.status,
          payload: errorText,
        });
      }
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new CodexApiError(`${response.status} status code${errorText ? `: ${errorText}` : " (no body)"}`, {
        status: response.status,
        payload: errorText,
      });
    }

    yield* parseSse(response, input.signal);
  }

  async function* streamWebSocketEvents(input: {
    requestBody: Record<string, unknown>;
    baseURL: string;
    sessionId: string;
    requestId: string;
    signal?: AbortSignal;
    resolveAuth: (forceRefresh?: boolean) => Promise<{ accessToken: string; accountId: string }>;
  }): AsyncIterable<Record<string, unknown>> {
    const { accessToken, accountId } = await input.resolveAuth(false);
    const socket = await connectCodexWebSocket(
      resolveCodexWebSocketUrl(input.baseURL),
      buildWebSocketHeaders(accessToken, accountId, input.sessionId, input.requestId),
      input.signal,
    );
    try {
      socket.send(JSON.stringify({ type: "response.create", ...input.requestBody }));
      yield* parseWebSocket(socket, input.signal, CODEX_SSE_HEADER_TIMEOUT_MS);
    } finally {
      closeWebSocketSilently(socket);
    }
  }

  async function complete(
    messages: ProviderMessage[],
    chatOptions?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal }
  ): Promise<string> {
    let content = "";
    for await (const chunk of streamChat(messages, {
      model: chatOptions?.model ?? "gpt-5.5",
      temperature: chatOptions?.temperature,
      thinkingLevel: chatOptions?.thinkingLevel,
      abortSignal: chatOptions?.abortSignal,
    })) {
      if (chunk.type === "text") {
        content += chunk.content;
      }
    }
    return content;
  }

  return { streamChat, complete };
}

function isTokenExpiredError(errorText: string): boolean {
  return /token_expired|session expired/i.test(errorText);
}

export function normalizeOpenAICodexUsage(usage: any): TokenUsage {
  const promptTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const cachedTokens = typeof usage?.input_tokens_details?.cached_tokens === "number"
    ? usage.input_tokens_details.cached_tokens
    : undefined;

  return {
    promptTokens,
    completionTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
    promptCacheHitTokens: cachedTokens,
    promptCacheMissTokens: cachedTokens !== undefined ? Math.max(0, promptTokens - cachedTokens) : undefined,
    reasoningTokens: typeof usage?.output_tokens_details?.reasoning_tokens === "number"
      ? usage.output_tokens_details.reasoning_tokens
      : undefined,
    totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined,
  };
}

class CodexApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly payload?: unknown;

  constructor(message: string, options: { status?: number; code?: string; payload?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "CodexApiError";
    this.status = options.status;
    this.code = options.code;
    this.payload = options.payload;
  }
}

class CodexProtocolError extends Error {
  readonly payload?: unknown;

  constructor(message: string, options: { payload?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "CodexProtocolError";
    this.payload = options.payload;
  }
}

interface CodexToolCallState {
  currentToolCall?: {
    id: string;
    name: string;
    args: string;
  };
}

function* translateCodexEvent(event: Record<string, unknown>, state: CodexToolCallState): Iterable<StreamChunk> {
  const type = typeof event.type === "string" ? event.type : undefined;
  if (!type) return;

  if (type === "error") {
    const code = typeof event.code === "string" ? event.code : undefined;
    const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
    throw new CodexApiError(message || code || "Codex error", { code, payload: event });
  }

  if (type === "response.failed") {
    const response = event.response as { error?: { code?: string; message?: string } } | undefined;
    const code = response?.error?.code;
    const message = response?.error?.message;
    throw new CodexApiError(message || "Codex response failed", { code, payload: event });
  }

  if (type === "response.output_item.added") {
    const item = (event as any).item;
    if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      state.currentToolCall = {
        id: item.call_id,
        name: item.name,
        args: typeof item.arguments === "string" ? item.arguments : "",
      };
      yield {
        type: "tool_call",
        id: state.currentToolCall.id,
        name: state.currentToolCall.name,
        arguments: "",
        isStart: true,
        isEnd: false,
      };
    }
    return;
  }

  if (type === "response.output_text.delta" || type === "response.refusal.delta") {
    const delta = typeof (event as any).delta === "string" ? (event as any).delta : "";
    if (delta) yield { type: "text", content: delta };
    return;
  }

  if (type === "response.reasoning_summary_text.delta") {
    const delta = typeof (event as any).delta === "string" ? (event as any).delta : "";
    if (delta) yield { type: "reasoning_delta", content: delta };
    return;
  }

  if (type === "response.function_call_arguments.delta" && state.currentToolCall) {
    const delta = typeof (event as any).delta === "string" ? (event as any).delta : "";
    if (delta) {
      state.currentToolCall.args += delta;
      yield {
        type: "tool_call",
        id: state.currentToolCall.id,
        name: state.currentToolCall.name,
        arguments: delta,
        isStart: false,
        isEnd: false,
      };
    }
    return;
  }

  if (type === "response.function_call_arguments.done" && state.currentToolCall) {
    const finalArgs = typeof (event as any).arguments === "string" ? (event as any).arguments : state.currentToolCall.args;
    if (finalArgs.startsWith(state.currentToolCall.args)) {
      const tail = finalArgs.slice(state.currentToolCall.args.length);
      if (tail) {
        state.currentToolCall.args = finalArgs;
        yield {
          type: "tool_call",
          id: state.currentToolCall.id,
          name: state.currentToolCall.name,
          arguments: tail,
          isStart: false,
          isEnd: false,
        };
      }
    } else {
      state.currentToolCall.args = finalArgs;
    }
    return;
  }

  if (type === "response.output_item.done" && state.currentToolCall) {
    const item = (event as any).item;
    if (item?.type === "function_call" && item.call_id === state.currentToolCall.id) {
      yield {
        type: "tool_call",
        id: state.currentToolCall.id,
        name: state.currentToolCall.name,
        arguments: "",
        isStart: false,
        isEnd: true,
      };
      state.currentToolCall = undefined;
    }
    return;
  }

  if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
    const usage = (event as any).response?.usage;
    if (usage) {
      yield {
        type: "usage",
        usage: normalizeOpenAICodexUsage(usage),
      };
    }
  }
}

function isCodexResponseEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === "string" ? event.type : "";
  return type.startsWith("response.");
}

export function buildOpenAICodexPromptCacheKey(input: {
  seed?: string;
  providerId?: string;
  model: string;
}): string | undefined {
  const seed = input.seed?.trim();
  if (!seed) return undefined;

  return createHash("sha256")
    .update(`bubble:${input.providerId || "openai-codex"}:${input.model}:${seed}`)
    .digest("hex");
}

export async function fetchOpenAICodexModels(options: {
  baseURL: string;
  accessToken: string;
  fetch?: ChatGptFetch;
}): Promise<CodexModelDescriptor[]> {
  const accountId = extractChatGptAccountId(options.accessToken);
  if (!accountId) {
    return [];
  }
  const fetchImpl = options.fetch ?? chatGptFetch;

  for (const path of MODEL_DISCOVERY_PATHS) {
    const response = await fetchImpl(resolveRelativeUrl(options.baseURL, path), {
      method: "GET",
      headers: buildBaseHeaders(
        options.accessToken,
        accountId,
        createCodexSessionId(),
        createCodexRequestId(),
        { accept: "application/json" },
      ),
    }).catch(() => undefined);

    if (!response?.ok) continue;

    const payload = await response.json().catch(() => undefined);
    const descriptors = extractCodexModelDescriptors(payload);
    if (descriptors.length > 0) {
      return sortCodexModelDescriptors(descriptors);
    }
  }

  return [];
}

function buildRequestBody(
  messages: ProviderMessage[],
  options: {
    model: string;
    tools?: ToolDefinition[];
    reasoningEffort?: ThinkingLevel;
    sessionId?: string;
    providerId?: string;
    promptCacheKey?: string;
  }
) {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const input = messages.flatMap((message) => convertMessage(message));
  const body: Record<string, unknown> = {
    model: options.model,
    store: false,
    stream: true,
    instructions: instructions || undefined,
    input,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: buildOpenAICodexPromptCacheKey({
      seed: options.promptCacheKey ?? options.sessionId,
      providerId: options.providerId,
      model: options.model,
    }),
    tool_choice: "auto",
    parallel_tool_calls: true,
    text: { verbosity: "medium" },
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  return body;
}

function convertMessage(message: ProviderMessage): Array<Record<string, unknown>> {
  if (message.role === "system") {
    return [];
  }

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return [{
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      }];
    }

    return [{
      role: "user",
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "input_text", text: part.text };
        }
        return { type: "input_image", detail: "auto", image_url: part.image_url.url };
      }),
    }];
  }

  if (message.role === "assistant") {
    const items: Array<Record<string, unknown>> = [];
    if (message.content) {
      items.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: message.content, annotations: [] }],
      });
    }
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        items.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments || "{}",
        });
      }
    }
    return items;
  }

  return [{
    type: "function_call_output",
    call_id: message.toolCallId,
    output: message.content,
  }];
}

async function* parseSse(response: Response, signal?: AbortSignal): AsyncIterable<Record<string, unknown>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw toAbortError(signal);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw toAbortError(signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();

        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch (cause) {
            throw new CodexProtocolError(`Invalid Codex SSE JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
              payload: data,
              cause,
            });
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface CodexWebSocketLike {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

type CodexWebSocketConstructor = new (
  url: string | URL,
  options?: string | string[] | Record<string, unknown>,
) => CodexWebSocketLike;

class WebSocketCloseError extends Error {
  readonly code?: number;
  readonly reason?: string;

  constructor(message: string, options: { code?: number; reason?: string } = {}) {
    super(message);
    this.name = "WebSocketCloseError";
    this.code = options.code;
    this.reason = options.reason;
  }
}

const websocketSseFallbackSessions = new Set<string>();

export function resetOpenAICodexTransportStateForTests(): void {
  websocketSseFallbackSessions.clear();
  cachedWebSocketConstructor = null;
}

let cachedWebSocketConstructor: CodexWebSocketConstructor | null = null;

async function getWebSocketConstructor(): Promise<CodexWebSocketConstructor | null> {
  if (cachedWebSocketConstructor) return cachedWebSocketConstructor;
  const baseCtor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof baseCtor !== "function") return null;

  if (isBunRuntime() && hasChatGptProxyEnv()) {
    const proxyModule = await import("proxy-from-env");
    const getProxyForUrl = (proxyModule as { getProxyForUrl: (url: string) => string }).getProxyForUrl;
    const BaseWebSocket = baseCtor as CodexWebSocketConstructor;
    cachedWebSocketConstructor = class extends (BaseWebSocket as any) {
      constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
        const target = url.toString();
        const proxyTarget = target.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
        const proxy = getProxyForUrl(proxyTarget) || getChatGptProxyForUrl(proxyTarget);
        const normalizedOptions = typeof options === "string" || Array.isArray(options)
          ? { protocols: options }
          : { ...(options ?? {}) };
        super(url, { ...normalizedOptions, ...(proxy ? { proxy } : {}) });
      }
    } as CodexWebSocketConstructor;
    return cachedWebSocketConstructor;
  }

  cachedWebSocketConstructor = baseCtor as CodexWebSocketConstructor;
  return cachedWebSocketConstructor;
}

async function connectCodexWebSocket(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
  connectTimeoutMs = CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS,
): Promise<CodexWebSocketLike> {
  const WebSocketCtor = await getWebSocketConstructor();
  if (!WebSocketCtor) throw new Error("WebSocket transport is not available in this runtime");

  return new Promise<CodexWebSocketLike>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let socket: CodexWebSocketLike;

    try {
      socket = new WebSocketCtor(url, { headers: headersToRecord(headers) });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error, closeReason?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeReason) closeWebSocketSilently(socket, 1000, closeReason);
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: unknown) => fail(extractWebSocketError(event));
    const onClose = (event: unknown) => fail(extractWebSocketCloseError(event));
    const onAbort = () => fail(toAbortError(signal), "aborted");

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);

    if (connectTimeoutMs > 0) {
      timeout = setTimeout(() => {
        fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
      }, connectTimeoutMs);
    }
    if (signal?.aborted) onAbort();
  });
}

async function* parseWebSocket(
  socket: CodexWebSocketLike,
  signal?: AbortSignal,
  firstEventTimeoutMs = CODEX_SSE_HEADER_TIMEOUT_MS,
): AsyncIterable<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | undefined;
  let done = false;
  let failed: Error | undefined;
  let sawCompletion = false;
  let sawResponseEvent = false;

  const wake = () => {
    const resolve = pending;
    pending = undefined;
    resolve?.();
  };
  const onMessage = (event: unknown) => {
    void (async () => {
      let text: string | null = null;
      try {
        if (!event || typeof event !== "object" || !("data" in event)) return;
        text = await decodeWebSocketData((event as { data?: unknown }).data);
        if (!text) return;
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (isCodexResponseEvent(parsed)) {
          sawResponseEvent = true;
        }
        if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
          sawCompletion = true;
          done = true;
        }
        queue.push(parsed);
        wake();
      } catch (cause) {
        failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
          payload: text,
          cause,
        });
        done = true;
        wake();
      }
    })();
  };
  const onError = (event: unknown) => {
    failed = extractWebSocketError(event);
    done = true;
    wake();
  };
  const onClose = (event: unknown) => {
    if (!sawCompletion && !failed) failed = extractWebSocketCloseError(event);
    done = true;
    wake();
  };
  const onAbort = () => {
    failed = toAbortError(signal);
    done = true;
    wake();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) throw toAbortError(signal);
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        pending = resolve;
        if (!sawResponseEvent && firstEventTimeoutMs > 0) {
          timeout = setTimeout(() => {
            failed = new Error(`WebSocket first response event timeout after ${firstEventTimeoutMs}ms`);
            done = true;
            closeWebSocketSilently(socket, 1000, "first_response_event_timeout");
            wake();
          }, firstEventTimeoutMs);
        }
      }).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
    }
    if (failed) throw failed;
    if (!sawCompletion) throw new Error("WebSocket stream closed before response.completed");
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function closeWebSocketSilently(socket: CodexWebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {
    // Ignore cleanup errors.
  }
}

function extractWebSocketError(event: unknown): Error {
  if (event && typeof event === "object") {
    const nested = (event as { error?: unknown }).error;
    if (nested instanceof Error) return nested;
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string" && message) return new Error(message);
  }
  return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === "object") {
    const code = (event as { code?: unknown }).code;
    const reason = (event as { reason?: unknown }).reason;
    const codeText = typeof code === "number" ? ` ${code}` : "";
    const reasonText = typeof reason === "string" && reason ? ` ${reason}` : "";
    return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
      code: typeof code === "number" ? code : undefined,
      reason: typeof reason === "string" && reason ? reason : undefined,
    });
  }
  return new Error("WebSocket closed");
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
    return new TextDecoder().decode(new Uint8Array(await blobLike.arrayBuffer()));
  }
  return null;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function resolveOpenAICodexTransport(configured?: OpenAICodexTransport): OpenAICodexTransport {
  const raw = configured ?? process.env.BUBBLE_CODEX_TRANSPORT?.trim() as OpenAICodexTransport | undefined;
  if (raw === "auto" || raw === "sse" || raw === "websocket") return raw;
  if (process.env.NODE_ENV === "test") return "sse";
  return "auto";
}

function initialCodexTransport(requested: OpenAICodexTransport, sessionId: string): "sse" | "websocket" {
  if (requested === "sse") return "sse";
  if (isWebSocketSseFallbackActive(sessionId)) return "sse";
  return "websocket";
}

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return !!sessionId && websocketSseFallbackSessions.has(sessionId);
}

function recordWebSocketSseFallback(sessionId: string | undefined, error: unknown): void {
  if (!sessionId) return;
  websocketSseFallbackSessions.add(sessionId);
  traceEvent("provider_transport_session_fallback", {
    providerId: "openai-codex",
    sessionIdHash: createHash("sha256").update(sessionId).digest("hex").slice(0, 16),
    fallbackTransport: "sse",
    error: summarizeTraceError(error),
  });
}

function shouldFallbackCodexWebSocket(input: {
  error: unknown;
  requestedTransport: OpenAICodexTransport;
  activeTransport: "sse" | "websocket";
  sawResponseEvent: boolean;
  signal?: AbortSignal;
}): boolean {
  if (input.activeTransport !== "websocket") return false;
  if (input.requestedTransport === "sse") return false;
  if (input.signal?.aborted) return false;
  if (input.sawResponseEvent) return false;
  if (isCodexNonTransportError(input.error)) return false;
  return true;
}

function isCodexNonTransportError(error: unknown): boolean {
  return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

function traceCodexTransportFailure(input: {
  error: unknown;
  model: string;
  transport: "sse" | "websocket";
  fallbackTransport?: "sse";
  phase: "before_message_stream_start" | "after_message_stream_start";
  url: string;
}): void {
  if (isCodexNonTransportError(input.error)) return;
  const failureKind = classifyChatGptNetworkError(input.error) ?? (/websocket/i.test(errorMessageChain(input.error).join("\n")) ? "websocket" : undefined);
  if (!failureKind && input.transport !== "websocket") return;
  traceEvent("provider_transport_failure", {
    providerId: "openai-codex",
    model: input.model,
    transport: input.transport,
    fallbackTransport: input.fallbackTransport,
    phase: input.phase,
    failureKind,
    network: getChatGptNetworkDiagnostics(input.url),
    error: summarizeTraceError(input.error),
  });
}

async function fetchWithSseHeaderTimeout(
  fetchImpl: ChatGptFetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const requestSignal = init.signal ?? undefined;
  const controller = new AbortController();
  const timeoutError = new Error(`Codex SSE response headers timed out after ${CODEX_SSE_HEADER_TIMEOUT_MS}ms`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<Response>((_resolve, reject) => {
    onAbort = () => {
      const error = toAbortError(requestSignal);
      controller.abort(error);
      reject(error);
    };
    requestSignal?.addEventListener("abort", onAbort, { once: true });
  });
  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, CODEX_SSE_HEADER_TIMEOUT_MS);
  });

  try {
    if (requestSignal?.aborted) throw toAbortError(requestSignal);
    const fetchPromise = fetchImpl(input, { ...init, signal: controller.signal });
    return await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) requestSignal?.removeEventListener("abort", onAbort);
  }
}

function buildCodexRequestInit(options: {
  accessToken: string;
  accountId: string;
  sessionId: string;
  requestId: string;
  signal?: AbortSignal;
  body: string;
}): RequestInit {
  const init: RequestInit & { verbose?: boolean } = {
    method: "POST",
    headers: buildSseHeaders(options.accessToken, options.accountId, options.sessionId, options.requestId),
    signal: options.signal,
    body: options.body,
    keepalive: false,
  };
  if (/^(1|true|yes)$/i.test(process.env.BUBBLE_CODEX_FETCH_VERBOSE ?? "")) {
    init.verbose = true;
  }
  return init;
}

function shouldRetryCodexTransportError(input: {
  error: unknown;
  attempt: number;
  sawParsedSseEvent: boolean;
  signal?: AbortSignal;
}): boolean {
  if (input.signal?.aborted) return false;
  if (input.sawParsedSseEvent) return false;
  if (input.attempt >= CODEX_TRANSPORT_MAX_RETRIES) return false;
  return isTransientCodexTransportError(input.error);
}

function isTransientCodexTransportError(error: unknown): boolean {
  if (isCodexNonTransportError(error)) return false;
  const kind = classifyChatGptNetworkError(error);
  if (!kind || kind === "abort") return false;
  if (kind === "tls_certificate") return false;
  return true;
}

function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof Error) {
      messages.push(current.name, current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of ["name", "code", "message"]) {
        if (typeof record[key] === "string") messages.push(record[key]);
      }
      current = record.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages;
}

function codexRetryDelayMs(attempt: number): number {
  return CODEX_TRANSPORT_RETRY_BASE_DELAY_MS * Math.pow(3, attempt);
}

function sleepBeforeCodexRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(toAbortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(toAbortError(signal));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException(typeof signal?.reason === "string" ? signal.reason : "Aborted", "AbortError");
}

function buildBaseHeaders(
  accessToken: string,
  accountId: string,
  sessionId: string,
  requestId: string,
  extraHeaders?: Record<string, string>
): Headers {
  const headers = new Headers(extraHeaders);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("ChatGPT-Account-Id", accountId);
  headers.set("originator", "bubble");
  headers.set("User-Agent", "bubble");
  headers.set("session-id", sessionId);
  headers.set("x-client-request-id", requestId);
  return headers;
}

function buildSseHeaders(accessToken: string, accountId: string, sessionId: string, requestId: string): Headers {
  const headers = buildBaseHeaders(accessToken, accountId, sessionId, requestId, {
    accept: "text/event-stream",
    "content-type": "application/json",
  });
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES);
  return headers;
}

function buildWebSocketHeaders(accessToken: string, accountId: string, sessionId: string, requestId: string): Headers {
  const headers = buildBaseHeaders(accessToken, accountId, sessionId, requestId);
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  return headers;
}

function resolveCodexUrl(baseURL: string): string {
  const normalized = (baseURL.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseURL: string): string {
  const url = new URL(resolveCodexUrl(baseURL));
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

function createCodexRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `bubble_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createCodexSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `bubble_session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRelativeUrl(baseURL: string, path: string): string {
  const normalized = (baseURL.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  return `${normalized}${path}`;
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

function extractCodexModelDescriptors(payload: unknown): CodexModelDescriptor[] {
  const out: CodexModelDescriptor[] = [];
  const seen = new Set<string>();

  const isCodexId = (value: unknown): value is string =>
    typeof value === "string" && /^gpt-|^codex-/i.test(value);

  const pickId = (record: Record<string, unknown>): string | undefined => {
    for (const key of ["slug", "id", "model_slug", "model"]) {
      const v = record[key];
      if (isCodexId(v)) return v;
    }
    return undefined;
  };

  const buildDescriptor = (record: Record<string, unknown>, id: string): CodexModelDescriptor => {
    const desc: CodexModelDescriptor = { id };

    const displayName = record.display_name;
    if (typeof displayName === "string" && displayName) desc.displayName = displayName;

    const ctx = record.context_window;
    if (typeof ctx === "number" && ctx > 0) desc.contextWindow = ctx;

    const visibility = record.visibility;
    if (typeof visibility === "string") desc.visibility = visibility;

    const minVer = record.minimal_client_version;
    if (typeof minVer === "string") desc.minimalClientVersion = minVer;

    const levels = record.supported_reasoning_levels;
    if (Array.isArray(levels)) {
      const efforts = new Set<ReasoningEffort>(["off"]);
      for (const level of levels) {
        const effort = (level as Record<string, unknown> | null | undefined)?.effort;
        if (typeof effort === "string" && (REASONING_EFFORTS as readonly string[]).includes(effort)) {
          efforts.add(effort as ReasoningEffort);
        }
      }
      desc.reasoningLevels = REASONING_EFFORTS.filter((e) => efforts.has(e));
    }

    const truncPolicy = record.truncation_policy as Record<string, unknown> | undefined;
    if (truncPolicy && truncPolicy.mode === "tokens") {
      const limit = truncPolicy.limit;
      if (typeof limit === "number" && limit > 0) {
        desc.toolOutputTokenLimit = limit;
      }
    }

    return desc;
  };

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const id = pickId(record);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(buildDescriptor(record, id));
    }

    for (const child of Object.values(record)) {
      if (child && typeof child === "object") visit(child);
    }
  };

  visit(payload);
  return out;
}

// Extracts the family version from a codex slug (e.g. "gpt-5.5-codex" → 5005).
// Used so models from a newer family float to the top even before the static
// catalog knows about them.
function parseCodexFamilyRank(id: string): number {
  const match = id.match(/(\d+)\.(\d+)/);
  if (!match) return 0;
  return parseInt(match[1], 10) * 1000 + parseInt(match[2], 10);
}

export function sortCodexModelDescriptors(descriptors: CodexModelDescriptor[]): CodexModelDescriptor[] {
  const preferred = new Map<string, number>(
    getOpenAICodexFallbackModels().map((id, index) => [id, index]),
  );
  return [...descriptors].sort((left, right) => {
    const leftFamily = parseCodexFamilyRank(left.id);
    const rightFamily = parseCodexFamilyRank(right.id);
    if (leftFamily !== rightFamily) return rightFamily - leftFamily;
    const leftRank = preferred.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = preferred.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.id.localeCompare(right.id);
  });
}

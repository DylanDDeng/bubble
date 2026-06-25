import { getAvailableThinkingLevels, normalizeThinkingLevel } from "./provider-transform.js";
import { RateLimitError, type RateLimitPolicy } from "./network/errors.js";
import { isProviderTransportError, normalizeProviderNetworkError, providerFetch } from "./network/provider-transport.js";
import {
  computeRetryDelayMs,
  getProviderMaxRetries,
  isRetryableHttpStatus,
  ProviderStreamInterruptedError,
  retryAfterMsFromResponse,
  sleepBeforeRetry,
} from "./network/retry.js";
import type { ContentPart, Provider, ProviderMessage, ProviderRawContentBlock, StreamChunk, ThinkingLevel, ToolChoiceMode, ToolDefinition, TokenUsage } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_OPUS_LONG_OUTPUT_MAX_TOKENS = 128000;
const ANTHROPIC_LONG_OUTPUT_MAX_TOKENS = 64000;
const ANTHROPIC_PROMPT_CACHE_CONTROL = { type: "ephemeral" } as const;
const MINIMAX_PROMPT_CACHE_MODELS = new Set([
  "minimax-m2.7",
  "minimax-m2.7-highspeed",
  "minimax-m2.5",
  "minimax-m2.5-highspeed",
  "minimax-m2.1",
  "minimax-m2.1-highspeed",
  "minimax-m2",
  "m2-her",
]);

export interface AnthropicProviderOptions {
  providerId?: string;
  apiKey: string;
  baseURL: string;
  thinkingLevel?: ThinkingLevel;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "none" };
  stream?: boolean;
  temperature?: number;
  thinking?: { type: "adaptive" };
  output_config?: { effort: AnthropicEffort };
}

// Anthropic's reasoning-depth control (GA, no beta header). budget_tokens is
// removed on Opus 4.7+/Fable 5; effort is the replacement and rides in
// output_config (NOT top-level). There is no "minimal" on the Anthropic enum.
type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

function anthropicEffortForLevel(level: ThinkingLevel): AnthropicEffort | undefined {
  switch (level) {
    case "off":
      return undefined;
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}

type AnthropicCacheControl = typeof ANTHROPIC_PROMPT_CACHE_CONTROL;

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ToolDefinition["parameters"];
  cache_control?: AnthropicCacheControl;
}

interface AnthropicStreamBlockState {
  type: string;
  id?: string;
  name?: string;
  args: string;
  started: boolean;
  input?: Record<string, unknown>;
  raw: ProviderRawContentBlock;
  text: string;
  thinking: string;
  signature: string;
}

export function createAnthropicMessagesProvider(options: AnthropicProviderOptions): Provider {
  async function* streamChat(
    messages: ProviderMessage[],
    chatOptions: { model: string; tools?: ToolDefinition[]; toolChoice?: ToolChoiceMode; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal; rateLimitPolicy?: RateLimitPolicy },
  ): AsyncIterable<StreamChunk> {
    const body = buildAnthropicRequest(options, messages, {
      model: chatOptions.model,
      tools: chatOptions.tools,
      toolChoice: chatOptions.toolChoice,
      temperature: chatOptions.temperature,
      thinkingLevel: chatOptions.thinkingLevel,
      stream: true,
    });

    const events = streamAnthropicEventsWithRetry(options, {
      url: resolveAnthropicMessagesUrl(options.baseURL),
      stream: true,
      method: "POST",
      body: JSON.stringify(body),
      signal: chatOptions.abortSignal,
      rateLimitPolicy: chatOptions.rateLimitPolicy,
    });

    yield* translateAnthropicStream(events);
    yield { type: "done" };
  }

  async function complete(
    messages: ProviderMessage[],
    chatOptions?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal },
  ): Promise<string> {
    const body = buildAnthropicRequest(options, messages, {
      model: chatOptions?.model ?? "claude-sonnet-4-6",
      temperature: chatOptions?.temperature,
      thinkingLevel: chatOptions?.thinkingLevel,
      stream: false,
    });

    const response = await fetchAnthropicResponseWithRetry(options, {
      url: resolveAnthropicMessagesUrl(options.baseURL),
      stream: false,
      method: "POST",
      body: JSON.stringify(body),
      signal: chatOptions?.abortSignal,
    });
    const data = await response.json() as { content?: Array<Record<string, unknown>> };
    return extractAnthropicText(data.content).join("");
  }

  return { streamChat, complete };
}

export function buildAnthropicRequest(
  options: AnthropicProviderOptions,
  messages: ProviderMessage[],
  chatOptions: {
    model: string;
    tools?: ToolDefinition[];
    toolChoice?: ToolChoiceMode;
    temperature?: number;
    thinkingLevel?: ThinkingLevel;
    stream?: boolean;
  },
): AnthropicRequest {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages, shouldEchoThinking(options.providerId));
  const enablePromptCache = supportsAnthropicPromptCache(options, chatOptions.model);
  const tools: AnthropicTool[] | undefined = chatOptions.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
  if (enablePromptCache && tools && tools.length > 0) {
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      cache_control: ANTHROPIC_PROMPT_CACHE_CONTROL,
    };
  }

  const effectiveThinkingLevel = normalizeThinkingLevel(
    chatOptions.thinkingLevel ?? options.thinkingLevel ?? "off",
    getAvailableThinkingLevels(options.providerId || "", chatOptions.model),
  );

  const body: AnthropicRequest = {
    model: chatOptions.model,
    max_tokens: resolveAnthropicMaxTokens(options, chatOptions.model),
    system: buildAnthropicSystem(system, enablePromptCache),
    messages: anthropicMessages,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: tools && tools.length > 0 ? { type: chatOptions.toolChoice ?? "auto" } : undefined,
    stream: chatOptions.stream || undefined,
  };
  if (
    typeof chatOptions.temperature === "number"
    && shouldSendTemperature(options, chatOptions.model, effectiveThinkingLevel)
  ) {
    body.temperature = chatOptions.temperature;
  }

  if (effectiveThinkingLevel !== "off") {
    body.thinking = { type: "adaptive" };
    // Apply the selected reasoning depth via output_config.effort. Without this
    // every thinking request silently ran at Anthropic's default (high),
    // ignoring the chosen level. effort is an official-API feature, so only
    // send it to the official endpoint — anthropic-compatible third parties
    // (e.g. MiniMax) reject it. Levels are already clamped to the model's
    // supported set, so the value is always a valid effort for this model.
    if (isOfficialAnthropicBaseUrl(options.baseURL)) {
      const effort = anthropicEffortForLevel(effectiveThinkingLevel);
      if (effort) {
        body.output_config = { effort };
      }
    }
  }

  return body;
}

export function resolveAnthropicMaxTokens(options: AnthropicProviderOptions, model: string): number {
  if (!isOfficialAnthropicBaseUrl(options.baseURL)) {
    return DEFAULT_MAX_TOKENS;
  }

  if (isFableModelWith128kOutput(model) || isOpusModelWith128kOutput(model)) {
    return ANTHROPIC_OPUS_LONG_OUTPUT_MAX_TOKENS;
  }

  if (isSonnetOrHaikuModelWith64kOutput(model)) {
    return ANTHROPIC_LONG_OUTPUT_MAX_TOKENS;
  }

  return DEFAULT_MAX_TOKENS;
}

function buildAnthropicSystem(system: string, enablePromptCache: boolean): AnthropicRequest["system"] {
  if (!system) return undefined;
  if (!enablePromptCache) return system;
  return [{ type: "text", text: system, cache_control: ANTHROPIC_PROMPT_CACHE_CONTROL }];
}

export function supportsAnthropicPromptCache(options: AnthropicProviderOptions, model: string): boolean {
  const providerId = (options.providerId ?? "").toLowerCase();
  if (providerId === "anthropic" || isOfficialAnthropicBaseUrl(options.baseURL)) {
    return true;
  }
  if (!isMiniMaxAnthropicEndpoint(options)) {
    return false;
  }
  return MINIMAX_PROMPT_CACHE_MODELS.has(model.toLowerCase());
}

export function toAnthropicMessages(
  messages: ProviderMessage[],
  echoThinking = false,
): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  const thinkingReplayIndexes = getThinkingReplayIndexes(messages, echoThinking);

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      pushAnthropicMessage(out, {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
        }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content = buildAssistantAnthropicBlocks(message, thinkingReplayIndexes.has(index));
      if (content.length > 0) {
        pushAnthropicMessage(out, { role: "assistant", content });
      }
      continue;
    }

    pushAnthropicMessage(out, {
      role: "user",
      content: typeof message.content === "string"
        ? message.content
        : contentPartsToAnthropicBlocks(message.content),
    });
  }

  return { system: system.join("\n\n"), messages: out };
}

function buildAssistantAnthropicBlocks(message: Extract<ProviderMessage, { role: "assistant" }>, includeThinking: boolean): AnthropicContentBlock[] {
  const rawBlocks = message.providerMetadata?.anthropic?.contentBlocks;
  if (rawBlocks && rawBlocks.length > 0) {
    const blocks = rawBlocks
      .filter(isReplayableAssistantContentBlock)
      .filter((block) => includeThinking || !isThinkingContentBlock(block))
      .map((block) => cloneAnthropicContentBlock(block));
    if (blocks.length > 0) {
      return blocks;
    }
  }

  const content: AnthropicContentBlock[] = [];
  if (includeThinking && message.reasoning?.trim()) {
    content.push({ type: "thinking", thinking: message.reasoning });
  }
  if (message.content.trim()) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.toolCalls ?? []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: parseToolInput(toolCall.arguments),
    });
  }
  return content;
}

function getThinkingReplayIndexes(messages: ProviderMessage[], echoThinking: boolean): Set<number> {
  const indexes = new Set<number>();
  if (!echoThinking) return indexes;

  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
    }
  }

  for (let index = Math.max(0, lastUserIndex + 1); index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant" && assistantHasToolUse(message)) {
      indexes.add(index);
    }
  }

  return indexes;
}

function assistantHasToolUse(message: Extract<ProviderMessage, { role: "assistant" }>): boolean {
  if (message.toolCalls && message.toolCalls.length > 0) return true;
  return message.providerMetadata?.anthropic?.contentBlocks?.some((block) => block.type === "tool_use") ?? false;
}

function isThinkingContentBlock(block: ProviderRawContentBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function isReplayableAssistantContentBlock(block: ProviderRawContentBlock): boolean {
  switch (block.type) {
    case "text":
      return typeof block.text === "string";
    case "thinking":
      return typeof block.thinking === "string";
    case "redacted_thinking":
      return typeof block.data === "string";
    case "tool_use":
      return typeof block.id === "string" && typeof block.name === "string" && isObjectRecord(block.input);
    default:
      return false;
  }
}

function cloneAnthropicContentBlock(block: ProviderRawContentBlock): AnthropicContentBlock {
  return JSON.parse(JSON.stringify(block)) as AnthropicContentBlock;
}

export async function* translateAnthropicStream(events: AsyncIterable<Record<string, unknown>>): AsyncIterable<StreamChunk> {
  const blocks = new Map<number, AnthropicStreamBlockState>();
  let usage: TokenUsage | undefined;

  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_start") {
      usage = mergeAnthropicUsage(usage, (event.message as Record<string, unknown> | undefined)?.usage);
      if (usage) yield { type: "usage", usage };
      continue;
    }
    if (type === "message_delta") {
      usage = mergeAnthropicUsage(usage, event.usage);
      if (usage) yield { type: "usage", usage };
      continue;
    }
    if (type === "error") {
      const err = event.error as Record<string, unknown> | undefined;
      throw new Error(`Anthropic stream error: ${String(err?.message || err?.type || "unknown error")}`);
    }
    if (type === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : 0;
      const block = event.content_block as Record<string, unknown> | undefined;
      const blockType = typeof block?.type === "string" ? block.type : "";
      const raw = cloneProviderBlock(block, blockType);
      const state: AnthropicStreamBlockState = {
        type: blockType,
        id: typeof block?.id === "string" ? block.id : undefined,
        name: typeof block?.name === "string" ? block.name : undefined,
        args: "",
        started: false,
        input: isObjectRecord(block?.input) ? block.input : undefined,
        raw,
        text: typeof block?.text === "string" ? block.text : "",
        thinking: typeof block?.thinking === "string" ? block.thinking : "",
        signature: typeof block?.signature === "string" ? block.signature : "",
      };
      blocks.set(index, state);
      if (blockType === "text" && typeof block?.text === "string" && block.text) {
        yield { type: "text", content: block.text };
      }
      if (blockType === "thinking" && typeof block?.thinking === "string" && block.thinking) {
        yield { type: "reasoning_delta", content: block.thinking };
      }
      if (blockType === "tool_use" && state.id && state.name) {
        state.started = true;
        yield { type: "tool_call", id: state.id, name: state.name, arguments: "", isStart: true, isEnd: false };
      }
      continue;
    }
    if (type === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : 0;
      const state = blocks.get(index);
      const delta = event.delta as Record<string, unknown> | undefined;
      const deltaType = typeof delta?.type === "string" ? delta.type : "";
      if (deltaType === "text_delta" && typeof delta?.text === "string" && delta.text) {
        if (state) {
          state.text += delta.text;
          state.raw.text = state.text;
        }
        yield { type: "text", content: delta.text };
      } else if (deltaType === "thinking_delta" && typeof delta?.thinking === "string" && delta.thinking) {
        if (state) {
          state.thinking += delta.thinking;
          state.raw.thinking = state.thinking;
        }
        yield { type: "reasoning_delta", content: delta.thinking };
      } else if (deltaType === "signature_delta" && typeof delta?.signature === "string" && state) {
        state.signature += delta.signature;
        state.raw.signature = state.signature;
      } else if (deltaType === "input_json_delta" && state?.id && state.name && typeof delta?.partial_json === "string") {
        state.args += delta.partial_json;
        if (!state.started) {
          state.started = true;
          yield { type: "tool_call", id: state.id, name: state.name, arguments: "", isStart: true, isEnd: false };
        }
        if (delta.partial_json) {
          yield { type: "tool_call", id: state.id, name: state.name, arguments: delta.partial_json, isStart: false, isEnd: false };
        }
      }
      continue;
    }
    if (type === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : 0;
      const state = blocks.get(index);
      blocks.delete(index);
      if (state?.type === "tool_use" && state.id && state.name) {
        const finalArgs = state.args || JSON.stringify(state.input ?? {});
        state.raw.input = parseToolInput(normalizeToolArgs(finalArgs));
        yield { type: "provider_content_block", provider: "anthropic", block: state.raw };
        yield {
          type: "tool_call",
          id: state.id,
          name: state.name,
          arguments: "",
          argumentsFull: normalizeToolArgs(finalArgs),
          isStart: false,
          isEnd: true,
        };
      } else if (state && isReplayableAssistantContentBlock(state.raw)) {
        finalizeRawContentBlock(state);
        yield { type: "provider_content_block", provider: "anthropic", block: state.raw };
      }
    }
  }
}

export async function* readSseEvents(response: Response): AsyncIterable<Record<string, unknown>> {
  if (!response.body) {
    throw new Error("Anthropic Messages API returned an empty stream body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseSseEvent(raw);
        if (event) yield event;
        separator = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const event = parseSseEvent(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

async function* streamAnthropicEventsWithRetry(
  options: AnthropicProviderOptions,
  request: {
    url: string;
    stream: true;
    method: "POST";
    body: string;
    signal?: AbortSignal;
    rateLimitPolicy?: RateLimitPolicy;
  },
): AsyncIterable<Record<string, unknown>> {
  const maxRetries = getProviderMaxRetries();

  for (let attempt = 0; ; attempt++) {
    // Connection-level failures and retryable HTTP statuses are retried
    // inside fetchAnthropicResponseWithRetry; an error thrown from it has
    // already exhausted its budget, so it propagates without another loop.
    const response = await fetchAnthropicResponseWithRetry(options, request);

    let sawSseEvent = false;
    try {
      for await (const event of readSseEvents(response)) {
        sawSseEvent = true;
        yield event;
      }
      return;
    } catch (error) {
      const normalized = normalizeAnthropicTransportError(error, request.url);
      if (sawSseEvent) {
        // Partial content already surfaced — only the agent loop can discard
        // the half-built assistant message and safely re-issue the request.
        if (!request.signal?.aborted && isProviderTransportError(error)) {
          throw new ProviderStreamInterruptedError(normalized.message, { cause: normalized });
        }
        throw normalized;
      }
      if (request.signal?.aborted || attempt >= maxRetries || !isProviderTransportError(error)) {
        throw normalized;
      }
      await sleepBeforeRetry(computeRetryDelayMs(attempt + 1), request.signal);
    }
  }
}

async function fetchAnthropicResponseWithRetry(
  options: AnthropicProviderOptions,
  request: {
    url: string;
    stream: boolean;
    method: "POST";
    body: string;
    signal?: AbortSignal;
    rateLimitPolicy?: RateLimitPolicy;
  },
): Promise<Response> {
  const maxRetries = getProviderMaxRetries();

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await providerFetch(request.url, {
        method: request.method,
        headers: buildAnthropicHeaders(options, request.stream),
        body: request.body,
        signal: request.signal,
        keepalive: false,
      }, {
        providerName: "Anthropic",
        verboseEnvVar: "BUBBLE_ANTHROPIC_FETCH_VERBOSE",
      });
    } catch (error) {
      // No response received, so the request is safe to re-issue.
      if (request.signal?.aborted || attempt >= maxRetries || !isProviderTransportError(error)) {
        throw normalizeAnthropicTransportError(error, request.url);
      }
      await sleepBeforeRetry(computeRetryDelayMs(attempt + 1), request.signal);
      continue;
    }
    if (response.ok) return response;

    const detail = await readAnthropicErrorDetail(response);

    // Rate-limit contract (design §4.5): under "defer" the transport performs
    // no 429 backoff and throws the typed error immediately; under "handle"
    // an exhausted 429 retry budget still surfaces as the typed error so the
    // caller can recognize it without string matching.
    if (response.status === 429) {
      const retryAfterMs = retryAfterMsFromResponse(response);
      if (request.rateLimitPolicy === "defer") {
        throw new RateLimitError(`Anthropic Messages API rate limited (429): ${detail || response.statusText}`, {
          status: 429,
          retryAfterMs,
        });
      }
      if (request.signal?.aborted || attempt >= maxRetries) {
        throw new RateLimitError(`Anthropic Messages API rate limited (429) after ${attempt + 1} attempts: ${detail || response.statusText}`, {
          status: 429,
          retryAfterMs,
        });
      }
      await sleepBeforeRetry(computeRetryDelayMs(attempt + 1, { retryAfterMs }), request.signal);
      continue;
    }

    const error = new Error(`Anthropic Messages API error ${response.status}: ${detail || response.statusText}`);

    if (request.signal?.aborted || attempt >= maxRetries || !isRetryableAnthropicHttpError(response.status, detail)) {
      throw error;
    }

    await sleepBeforeRetry(
      computeRetryDelayMs(attempt + 1, { retryAfterMs: retryAfterMsFromResponse(response) }),
      request.signal,
    );
  }
}

function resolveAnthropicMessagesUrl(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/v1/messages")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/messages`;
  return `${normalized || "https://api.anthropic.com"}/v1/messages`;
}

function buildAnthropicHeaders(options: AnthropicProviderOptions, stream: boolean): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": options.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (shouldSendBearerAuth(options)) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }
  if (stream) headers.accept = "text/event-stream";
  return headers;
}

async function readAnthropicErrorDetail(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

function normalizeAnthropicTransportError(error: unknown, url: string): Error {
  if (!isProviderTransportError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return normalizeProviderNetworkError(error, {
    providerName: "Anthropic",
    input: url,
  });
}

function isRetryableAnthropicHttpError(status: number, detail: string): boolean {
  // "714 (1000)" is a transient MiniMax backend error surfaced as a 500.
  return isRetryableHttpStatus(status) || detail.includes("714 (1000)");
}

function parseSseEvent(raw: string): Record<string, unknown> | undefined {
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") return undefined;
  return JSON.parse(data) as Record<string, unknown>;
}

function cloneProviderBlock(block: Record<string, unknown> | undefined, fallbackType: string): ProviderRawContentBlock {
  const type = typeof block?.type === "string" && block.type ? block.type : fallbackType || "unknown";
  const clone = block ? JSON.parse(JSON.stringify(block)) as Record<string, unknown> : {};
  clone.type = type;
  return clone as ProviderRawContentBlock;
}

function finalizeRawContentBlock(state: AnthropicStreamBlockState): void {
  if (state.type === "text") {
    state.raw.text = state.text;
  } else if (state.type === "thinking") {
    state.raw.thinking = state.thinking;
    if (state.signature) {
      state.raw.signature = state.signature;
    }
  }
}

function contentPartsToAnthropicBlocks(parts: ContentPart[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    const image = part.image_url.url;
    const dataUrlMatch = image.match(/^data:([^;,]+);base64,(.+)$/);
    if (dataUrlMatch) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: dataUrlMatch[1],
          data: dataUrlMatch[2],
        },
      });
    } else {
      blocks.push({ type: "image", source: { type: "url", url: image } });
    }
  }
  return blocks;
}

function pushAnthropicMessage(messages: AnthropicMessage[], next: AnthropicMessage): void {
  const last = messages.at(-1);
  if (!last || last.role !== next.role) {
    messages.push(next);
    return;
  }
  last.content = mergeAnthropicContent(last.content, next.content);
}

function mergeAnthropicContent(
  current: string | AnthropicContentBlock[],
  next: string | AnthropicContentBlock[],
): string | AnthropicContentBlock[] {
  const currentBlocks = typeof current === "string" ? [{ type: "text", text: current } satisfies AnthropicContentBlock] : current;
  const nextBlocks = typeof next === "string" ? [{ type: "text", text: next } satisfies AnthropicContentBlock] : next;
  return [...currentBlocks, ...nextBlocks];
}

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeToolArgs(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractAnthropicText(content: Array<Record<string, unknown>> | undefined): string[] {
  if (!content) return [];
  return content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []);
}

function mergeAnthropicUsage(current: TokenUsage | undefined, raw: unknown): TokenUsage | undefined {
  if (!isObjectRecord(raw)) return current;
  const rawInput = typeof raw.input_tokens === "number" ? raw.input_tokens : undefined;
  const rawCacheRead = typeof raw.cache_read_input_tokens === "number" ? raw.cache_read_input_tokens : undefined;
  const rawCacheCreation = typeof raw.cache_creation_input_tokens === "number" ? raw.cache_creation_input_tokens : undefined;
  const outputTokens = typeof raw.output_tokens === "number" ? raw.output_tokens : current?.completionTokens ?? 0;
  const hasPromptUsage = rawInput !== undefined || rawCacheRead !== undefined || rawCacheCreation !== undefined;

  let promptTokens = current?.promptTokens ?? 0;
  let promptCacheHitTokens = current?.promptCacheHitTokens;
  let promptCacheMissTokens = current?.promptCacheMissTokens;
  let cacheCreationTokens = current?.cacheCreationTokens;
  if (hasPromptUsage) {
    const inputTokens = rawInput ?? promptCacheMissTokens ?? promptTokens;
    const cacheRead = rawCacheRead ?? promptCacheHitTokens ?? 0;
    const cacheCreation = rawCacheCreation ?? 0;
    promptTokens = inputTokens + cacheRead + cacheCreation;
    promptCacheHitTokens = cacheRead;
    promptCacheMissTokens = inputTokens + cacheCreation;
    cacheCreationTokens = cacheCreation;
  }

  return {
    promptTokens,
    completionTokens: outputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cacheCreationTokens,
    totalTokens: promptTokens + outputTokens,
  };
}

function shouldEchoThinking(providerId?: string): boolean {
  return providerId?.startsWith("minimax") ?? false;
}

function shouldSendBearerAuth(options: AnthropicProviderOptions): boolean {
  return !isOfficialAnthropicBaseUrl(options.baseURL) || options.providerId?.startsWith("minimax") === true;
}

function shouldSendTemperature(options: AnthropicProviderOptions, model: string, thinkingLevel: ThinkingLevel): boolean {
  if (!isOfficialAnthropicBaseUrl(options.baseURL)) return true;
  if (thinkingLevel !== "off") return false;
  return !isOpusModelWithoutSamplingControls(model);
}

function isOpusModelWith128kOutput(model: string): boolean {
  return isClaudeFamilyVersionAtLeast(model, "opus", 4, 6);
}

function isFableModelWith128kOutput(model: string): boolean {
  return model.toLowerCase().startsWith("claude-fable-5");
}

function isSonnetOrHaikuModelWith64kOutput(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.startsWith("claude-sonnet-4-6")
    || normalized.startsWith("claude-haiku-4-5");
}

function isOpusModelWithoutSamplingControls(model: string): boolean {
  return isClaudeFamilyVersionAtLeast(model, "opus", 4, 7);
}

function isClaudeFamilyVersionAtLeast(model: string, family: string, minMajor: number, minMinor: number): boolean {
  const normalized = model.toLowerCase();
  if (!normalized.startsWith(`claude-${family}-`)) return false;

  const [, , majorSegment, minorSegment] = normalized.split("-");
  const major = Number(majorSegment);
  if (!Number.isFinite(major)) return false;
  if (major > minMajor) return true;
  if (major < minMajor) return false;

  if (!minorSegment || minorSegment.length > 2) return false;
  const minor = Number(minorSegment);
  return Number.isFinite(minor) && minor >= minMinor;
}

function isMiniMaxAnthropicEndpoint(options: AnthropicProviderOptions): boolean {
  const providerId = (options.providerId ?? "").toLowerCase();
  if (providerId !== "minimax" && providerId !== "minimax-anthropic") return false;
  try {
    const url = new URL(options.baseURL);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    return (host === "api.minimax.io" || host === "api.minimaxi.com") && path.includes("/anthropic");
  } catch {
    return false;
  }
}

function isOfficialAnthropicBaseUrl(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

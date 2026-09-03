import { createProviderProtocolArtifactFilter } from "./provider-artifacts.js";
import { RateLimitError, type RateLimitPolicy } from "./network/errors.js";
import {
  computeRetryDelayMs,
  getProviderMaxRetries,
  isRetryableHttpStatus,
  retryAfterMsFromResponse,
  sleepBeforeRetry,
} from "./network/retry.js";
import { providerFetch } from "./network/provider-transport.js";
import type { Provider, ProviderMessage, StreamChunk, ThinkingLevel, TokenUsage, ToolChoiceMode, ToolDefinition } from "./types.js";

export interface ResponsesProviderOptions {
  providerId?: string;
  apiKey: string;
  baseURL: string;
  thinkingLevel?: ThinkingLevel;
  /** User-configured extra headers, merged last (client-identity gates). */
  headers?: Record<string, string>;
}

export type ArkResponsesProviderOptions = ResponsesProviderOptions;

interface ResponsesChatOptions {
  model: string;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoiceMode;
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
  abortSignal?: AbortSignal;
  rateLimitPolicy?: RateLimitPolicy;
}

type ArkResponseItem = Record<string, unknown>;
type ResponsesDialect = "ark" | "openai";

const DEFAULT_ARK_MODEL = "doubao-seed-2-1-pro-260628";
const DEFAULT_MUSE_MODEL = "muse-spark-1.3-contributor-free";

export function createArkResponsesProvider(options: ArkResponsesProviderOptions): Provider {
  return createResponsesProvider(options, "ark", DEFAULT_ARK_MODEL);
}

export function createOpenAIResponsesProvider(options: ResponsesProviderOptions): Provider {
  return createResponsesProvider(options, "openai", DEFAULT_MUSE_MODEL);
}

function createResponsesProvider(
  options: ResponsesProviderOptions,
  dialect: ResponsesDialect,
  defaultModel: string,
): Provider {
  async function* streamChat(
    messages: ProviderMessage[],
    chatOptions: ResponsesChatOptions,
  ): AsyncIterable<StreamChunk> {
    const body = buildResponsesBody(messages, {
      model: chatOptions.model,
      tools: chatOptions.tools,
      toolChoice: chatOptions.toolChoice,
      temperature: chatOptions.temperature,
      thinkingLevel: chatOptions.thinkingLevel ?? options.thinkingLevel ?? "high",
      stream: true,
    }, dialect);

    for (let attempt = 0; ; attempt += 1) {
      const response = await sendArkResponsesRequest(options, body, {
        signal: chatOptions.abortSignal,
        rateLimitPolicy: chatOptions.rateLimitPolicy,
        attempt,
      });
      yield* translateArkResponsesStream(response, dialect === "openai");
      yield { type: "done" };
      return;
    }
  }

  async function complete(
    messages: ProviderMessage[],
    chatOptions?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal },
  ): Promise<string> {
    const body = buildResponsesBody(messages, {
      model: chatOptions?.model ?? defaultModel,
      temperature: chatOptions?.temperature,
      thinkingLevel: chatOptions?.thinkingLevel ?? options.thinkingLevel ?? "high",
      stream: false,
    }, dialect);
    const response = await sendArkResponsesRequest(options, body, {
      signal: chatOptions?.abortSignal,
      attempt: 0,
    });
    const payload = await response.json().catch(() => undefined);
    return extractArkResponsesText(payload);
  }

  return { streamChat, complete };
}

export function buildArkResponsesBody(
  messages: ProviderMessage[],
  options: {
    model: string;
    tools?: ToolDefinition[];
    toolChoice?: ToolChoiceMode;
    thinkingLevel?: ThinkingLevel;
    stream: boolean;
  },
): Record<string, unknown> {
  return buildResponsesBody(messages, options, "ark");
}

export function buildOpenAIResponsesBody(
  messages: ProviderMessage[],
  options: {
    model: string;
    tools?: ToolDefinition[];
    toolChoice?: ToolChoiceMode;
    temperature?: number;
    thinkingLevel?: ThinkingLevel;
    stream: boolean;
  },
): Record<string, unknown> {
  return buildResponsesBody(messages, options, "openai");
}

function buildResponsesBody(
  messages: ProviderMessage[],
  options: {
    model: string;
    tools?: ToolDefinition[];
    toolChoice?: ToolChoiceMode;
    temperature?: number;
    thinkingLevel?: ThinkingLevel;
    stream: boolean;
  },
  dialect: ResponsesDialect,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    input: messages.flatMap((message) => convertMessageToResponsesInput(message, dialect)),
    store: false,
    stream: options.stream,
  };

  if (dialect === "ark") {
    body.thinking = {
      type: shouldDisableArkThinking(options.thinkingLevel) ? "disabled" : "enabled",
    };
  } else {
    body.include = ["reasoning.encrypted_content"];
    if (options.thinkingLevel && options.thinkingLevel !== "off") {
      body.reasoning = {
        effort: options.thinkingLevel === "ultra" ? "xhigh" : options.thinkingLevel,
        summary: "auto",
      };
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    if (options.toolChoice === "none") {
      body.tool_choice = "none";
    }
  }

  return body;
}

function shouldDisableArkThinking(level: ThinkingLevel | undefined): boolean {
  return level === "off" || level === "minimal";
}

function convertMessageToResponsesInput(message: ProviderMessage, dialect: ResponsesDialect): ArkResponseItem[] {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return [{
        type: "message",
        role: "user",
        content: message.content,
      }];
    }

    return [{
      type: "message",
      role: "user",
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "input_text", text: part.text };
        }
        return { type: "input_image", image_url: part.image_url.url };
      }),
    }];
  }

  if (message.role === "system") {
    return [{
      type: "message",
      role: "system",
      content: message.content,
    }];
  }

  if (message.role === "assistant") {
    const items: ArkResponseItem[] = [];
    if (dialect === "openai") {
      for (const block of message.providerMetadata?.openai?.contentBlocks ?? []) {
        if (block.type !== "reasoning" || typeof block.encrypted_content !== "string") continue;
        items.push({
          type: "reasoning",
          summary: Array.isArray(block.summary) ? block.summary : [],
          encrypted_content: block.encrypted_content,
        });
      }
    }
    if (message.content) {
      items.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: message.content, annotations: [] }],
      });
    }
    for (const toolCall of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments || "{}",
        status: "completed",
      });
    }
    return items;
  }

  return [{
    type: "function_call_output",
    call_id: message.toolCallId,
    output: message.content,
  }];
}

async function sendArkResponsesRequest(
  options: ArkResponsesProviderOptions,
  body: Record<string, unknown>,
  requestOptions: {
    signal?: AbortSignal;
    rateLimitPolicy?: RateLimitPolicy;
    attempt: number;
  },
): Promise<Response> {
  const response = await providerFetch(resolveArkResponsesUrl(options.baseURL), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "Accept": body.stream ? "text/event-stream" : "application/json",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: requestOptions.signal,
  }, {
    providerName: options.providerId ?? "Responses provider",
  });

  if (response.ok) return response;

  const errorText = await response.text().catch(() => "");
  if (response.status === 429) {
    const retryAfterMs = retryAfterMsFromResponse(response);
    if (
      requestOptions.rateLimitPolicy !== "defer"
      && requestOptions.attempt < getProviderMaxRetries()
    ) {
      await sleepBeforeRetry(computeRetryDelayMs(requestOptions.attempt + 1, { retryAfterMs }), requestOptions.signal);
      return sendArkResponsesRequest(options, body, {
        ...requestOptions,
        attempt: requestOptions.attempt + 1,
      });
    }
    throw new RateLimitError(errorText || "Rate limited (429)", {
      status: 429,
      retryAfterMs,
    });
  }

  if (isRetryableHttpStatus(response.status) && requestOptions.attempt < getProviderMaxRetries()) {
    await sleepBeforeRetry(computeRetryDelayMs(requestOptions.attempt + 1), requestOptions.signal);
    return sendArkResponsesRequest(options, body, {
      ...requestOptions,
      attempt: requestOptions.attempt + 1,
    });
  }

  throw new Error(`${response.status} status code${errorText ? `: ${errorText}` : " (no body)"}`);
}

function resolveArkResponsesUrl(baseURL: string): string {
  return `${baseURL.trim().replace(/\/+$/, "")}/responses`;
}

export async function* translateArkResponsesStream(
  response: Response,
  captureOpenAIReasoning = false,
): AsyncIterable<StreamChunk> {
  const toolCalls = new Map<string, { id: string; name: string; args: string; started: boolean; corrupt?: boolean }>();
  const textFilter = createProviderProtocolArtifactFilter();

  for await (const event of parseArkResponsesSse(response)) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) continue;

    if (type === "error") {
      const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
      throw new Error(message);
    }

    if (type === "response.failed") {
      const message = typeof (event.response as any)?.error?.message === "string"
        ? (event.response as any).error.message
        : "Ark Responses request failed";
      throw new Error(message);
    }

    if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
        const key = toolCallEventKey(event, item);
        const entry = {
          id: item.call_id,
          name: item.name,
          args: typeof item.arguments === "string" ? item.arguments : "",
          started: true,
        };
        toolCalls.set(key, entry);
        yield {
          type: "tool_call",
          id: entry.id,
          name: entry.name,
          arguments: "",
          isStart: true,
          isEnd: false,
        };
      }
      continue;
    }

    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        const cleaned = textFilter.push(delta);
        if (cleaned) yield { type: "text", content: cleaned };
      }
      continue;
    }

    if (type === "response.reasoning_summary_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        yield { type: "reasoning_delta", content: delta };
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const entry = toolCalls.get(toolCallEventKey(event));
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (entry && delta) {
        entry.args += delta;
        yield {
          type: "tool_call",
          id: entry.id,
          name: entry.name,
          arguments: delta,
          isStart: false,
          isEnd: false,
        };
      }
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const entry = toolCalls.get(toolCallEventKey(event));
      if (entry) {
        const finalArgs = typeof event.arguments === "string" ? event.arguments : entry.args;
        if (finalArgs.startsWith(entry.args)) {
          const tail = finalArgs.slice(entry.args.length);
          if (tail) {
            yield {
              type: "tool_call",
              id: entry.id,
              name: entry.name,
              arguments: tail,
              isStart: false,
              isEnd: false,
            };
          }
        }
        entry.args = finalArgs;
      }
      continue;
    }

    if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (
        captureOpenAIReasoning
        && item?.type === "reasoning"
        && typeof item.encrypted_content === "string"
      ) {
        yield {
          type: "provider_content_block",
          provider: "openai",
          block: {
            type: "reasoning",
            summary: Array.isArray(item.summary) ? item.summary : [],
            encrypted_content: item.encrypted_content,
          },
        };
      }
      if (item?.type === "function_call") {
        const key = toolCallEventKey(event, item);
        const entry = toolCalls.get(key);
        if (entry) {
          const finalArgs = typeof item.arguments === "string" ? item.arguments : entry.args;
          const normalized = normalizeToolArgsDetailed(finalArgs);
          yield {
            type: "tool_call",
            id: entry.id,
            name: entry.name,
            arguments: "",
            argumentsFull: normalized.args,
            argumentsCorrupt: normalized.corrupt || undefined,
            isStart: false,
            isEnd: true,
          };
          toolCalls.delete(key);
        }
      }
      continue;
    }

    if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
      const remainingText = textFilter.flush();
      if (remainingText) {
        yield { type: "text", content: remainingText };
      }
      for (const [key, entry] of toolCalls) {
        const normalized = normalizeToolArgsDetailed(entry.args);
        yield {
          type: "tool_call",
          id: entry.id,
          name: entry.name,
          arguments: "",
          argumentsFull: normalized.args,
          argumentsCorrupt: normalized.corrupt || type === "response.incomplete" || undefined,
          isStart: false,
          isEnd: true,
        };
        toolCalls.delete(key);
      }
      const usage = (event.response as any)?.usage;
      if (usage) {
        yield {
          type: "usage",
          usage: normalizeArkResponsesUsage(usage),
        };
      }
      continue;
    }
  }

  const remainingText = textFilter.flush();
  if (remainingText) {
    yield { type: "text", content: remainingText };
  }
  for (const [, entry] of toolCalls) {
    const normalized = normalizeToolArgsDetailed(entry.args);
    yield {
      type: "tool_call",
      id: entry.id,
      name: entry.name,
      arguments: "",
      argumentsFull: normalized.args,
      argumentsCorrupt: normalized.corrupt || undefined,
      isStart: false,
      isEnd: true,
    };
  }
}

function toolCallEventKey(event: Record<string, unknown>, item?: Record<string, unknown>): string {
  if (typeof event.output_index === "number") return `output:${event.output_index}`;
  const itemId = typeof event.item_id === "string"
    ? event.item_id
    : typeof item?.id === "string"
      ? item.id
      : undefined;
  if (itemId) return itemId;
  return "output:0";
}

async function* parseArkResponsesSse(response: Response): AsyncIterable<Record<string, unknown>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
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
          } catch {
            // Ignore malformed event frames; the provider will surface failure
            // through response.failed when the request itself failed.
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export function normalizeArkResponsesUsage(usage: any): TokenUsage {
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

function extractArkResponsesText(payload: any): string {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const text: string[] = [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
        text.push(part.text);
      }
    }
  }
  return text.join("");
}

function normalizeToolArgsDetailed(raw: string): { args: string; corrupt: boolean } {
  const s = (raw ?? "").trim();
  if (!s) return { args: "{}", corrupt: false };
  try {
    JSON.parse(s);
    return { args: s, corrupt: false };
  } catch {
    const balanced = extractBalancedJson(s, 0);
    if (!balanced) return { args: "{}", corrupt: true };
    try {
      JSON.parse(balanced);
      return { args: balanced, corrupt: false };
    } catch {
      return { args: "{}", corrupt: true };
    }
  }
}

function extractBalancedJson(s: string, start: number): string | null {
  if (s[start] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inStr) {
      escape = true;
      continue;
    }
    if (c === "\"") {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

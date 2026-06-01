import { getAvailableThinkingLevels, normalizeThinkingLevel } from "./provider-transform.js";
import type { ContentPart, Provider, ProviderMessage, StreamChunk, ThinkingLevel, ToolDefinition, TokenUsage } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

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
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" };
  stream?: boolean;
  temperature?: number;
  thinking?: { type: "adaptive" };
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } }
  | { type: "thinking"; thinking: string }
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
}

interface AnthropicStreamBlockState {
  type: string;
  id?: string;
  name?: string;
  args: string;
  started: boolean;
  input?: Record<string, unknown>;
}

export function createAnthropicMessagesProvider(options: AnthropicProviderOptions): Provider {
  async function* streamChat(
    messages: ProviderMessage[],
    chatOptions: { model: string; tools?: ToolDefinition[]; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal },
  ): AsyncIterable<StreamChunk> {
    const body = buildAnthropicRequest(options, messages, {
      model: chatOptions.model,
      tools: chatOptions.tools,
      temperature: chatOptions.temperature,
      thinkingLevel: chatOptions.thinkingLevel,
      stream: true,
    });

    const response = await fetch(resolveAnthropicMessagesUrl(options.baseURL), {
      method: "POST",
      headers: buildAnthropicHeaders(options, true),
      body: JSON.stringify(body),
      signal: chatOptions.abortSignal,
    });
    await assertAnthropicResponseOk(response);

    yield* translateAnthropicStream(readSseEvents(response));
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

    const response = await fetch(resolveAnthropicMessagesUrl(options.baseURL), {
      method: "POST",
      headers: buildAnthropicHeaders(options, false),
      body: JSON.stringify(body),
      signal: chatOptions?.abortSignal,
    });
    await assertAnthropicResponseOk(response);
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
    temperature?: number;
    thinkingLevel?: ThinkingLevel;
    stream?: boolean;
  },
): AnthropicRequest {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages, shouldEchoThinking(options.providerId));
  const tools = chatOptions.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));

  const body: AnthropicRequest = {
    model: chatOptions.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: system || undefined,
    messages: anthropicMessages,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: tools && tools.length > 0 ? { type: "auto" } : undefined,
    stream: chatOptions.stream || undefined,
  };
  if (typeof chatOptions.temperature === "number") {
    body.temperature = chatOptions.temperature;
  }

  const effectiveThinkingLevel = normalizeThinkingLevel(
    chatOptions.thinkingLevel ?? options.thinkingLevel ?? "off",
    getAvailableThinkingLevels(options.providerId || "", chatOptions.model),
  );
  if (effectiveThinkingLevel !== "off") {
    body.thinking = { type: "adaptive" };
  }

  return body;
}

export function toAnthropicMessages(
  messages: ProviderMessage[],
  echoThinking = false,
): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
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
      const content: AnthropicContentBlock[] = [];
      if (echoThinking && message.reasoning?.trim()) {
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
      const state: AnthropicStreamBlockState = {
        type: blockType,
        id: typeof block?.id === "string" ? block.id : undefined,
        name: typeof block?.name === "string" ? block.name : undefined,
        args: "",
        started: false,
        input: isObjectRecord(block?.input) ? block.input : undefined,
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
        yield { type: "text", content: delta.text };
      } else if (deltaType === "thinking_delta" && typeof delta?.thinking === "string" && delta.thinking) {
        yield { type: "reasoning_delta", content: delta.thinking };
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
        yield {
          type: "tool_call",
          id: state.id,
          name: state.name,
          arguments: "",
          argumentsFull: normalizeToolArgs(finalArgs),
          isStart: false,
          isEnd: true,
        };
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

async function assertAnthropicResponseOk(response: Response): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    detail = await response.text();
  } catch {
    detail = response.statusText;
  }
  throw new Error(`Anthropic Messages API error ${response.status}: ${detail || response.statusText}`);
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
  if (hasPromptUsage) {
    const inputTokens = rawInput ?? promptCacheMissTokens ?? promptTokens;
    const cacheRead = rawCacheRead ?? promptCacheHitTokens ?? 0;
    const cacheCreation = rawCacheCreation ?? 0;
    promptTokens = inputTokens + cacheRead + cacheCreation;
    promptCacheHitTokens = cacheRead;
    promptCacheMissTokens = inputTokens + cacheCreation;
  }

  return {
    promptTokens,
    completionTokens: outputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    totalTokens: promptTokens + outputTokens,
  };
}

function shouldEchoThinking(providerId?: string): boolean {
  return providerId?.startsWith("minimax") ?? false;
}

function shouldSendBearerAuth(options: AnthropicProviderOptions): boolean {
  return !isOfficialAnthropicBaseUrl(options.baseURL) || options.providerId?.startsWith("minimax") === true;
}

function isOfficialAnthropicBaseUrl(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

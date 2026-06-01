/**
 * OpenAI-compatible Provider implementation.
 *
 * Works with OpenRouter, OpenAI, DeepSeek, Google, Groq, Together, and local OpenAI-compatible endpoints.
 */

import OpenAI from "openai";
import { appendFileSync } from "node:fs";
import { createAnthropicMessagesProvider } from "./provider-anthropic.js";
import { createOpenAICodexProvider, isOpenAICodexBaseUrl, type OpenAICodexAuthAdapter } from "./provider-openai-codex.js";
import { createProviderProtocolArtifactFilter } from "./provider-artifacts.js";
import { resolveProviderRequestConfig } from "./provider-transform.js";
import { debugReasoningStream, summarizeDebugText } from "./reasoning-debug.js";
import type { ProviderProtocol } from "./model-catalog.js";
import type { Provider, ProviderMessage, StreamChunk, ThinkingLevel, ToolDefinition } from "./types.js";

// Diagnostic logger for tool-args byte-loss investigation. Activate with
//   BUBBLE_DEBUG_TOOL_ARGS=/path/to/log.jsonl   (any writable path)
// Each line is a JSON record describing a transition. When debugging is off,
// the function is a no-op and free.
const TOOL_ARGS_DEBUG_PATH = process.env.BUBBLE_DEBUG_TOOL_ARGS?.trim();
function debugToolArgs(event: Record<string, unknown>): void {
  if (!TOOL_ARGS_DEBUG_PATH) return;
  try {
    appendFileSync(TOOL_ARGS_DEBUG_PATH, JSON.stringify({ t: Date.now(), ...event }) + "\n", "utf-8");
  } catch {
    // Diagnostic failures must not affect the model session.
  }
}

type ReasoningContentEcho = "tool_calls" | "all" | "none" | "minimax";
export type ToolArgsMergeMode = "delta" | "snapshot";

export interface TranslateOpenAIStreamOptions {
  toolArgsMergeMode?: ToolArgsMergeMode;
  reasoningMergeMode?: ToolArgsMergeMode;
  textMergeMode?: ToolArgsMergeMode;
  debugProviderId?: string;
  debugModelId?: string;
}

export function toChatCompletionsMessage(
  message: ProviderMessage,
  options: { reasoningContentEcho?: ReasoningContentEcho } = {},
): Record<string, unknown> {
  const reasoningContentEcho = options.reasoningContentEcho ?? "tool_calls";
  if (message.role === "assistant") {
    const out: Record<string, unknown> = {
      role: "assistant",
      content: message.content || null,
    };
    if (reasoningContentEcho === "all") {
      // DeepSeek thinking mode requires every assistant message to echo the
      // provider field, even when the original value is an empty string.
      out.reasoning_content = message.reasoning ?? "";
    }
    if (reasoningContentEcho === "minimax" && message.reasoning) {
      out.reasoning_details = [{
        type: "reasoning.text",
        id: "reasoning-text-1",
        format: "MiniMax-response-v1",
        index: 0,
        text: message.reasoning,
      }];
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      out.tool_calls = message.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      }));
      // Kimi-k2.5 with thinking enabled requires reasoning_content to be echoed
      // back on assistant messages that carry tool_calls.
      if (message.reasoning && reasoningContentEcho === "tool_calls") {
        out.reasoning_content = message.reasoning;
      }
    }
    return out;
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return { role: message.role, content: message.content };
}

export interface ProviderInstanceOptions {
  providerId?: string;
  apiKey: string;
  baseURL: string;
  /** Requested thinking level */
  thinkingLevel?: ThinkingLevel;
  /** Stable per-session seed for provider prompt caches. */
  promptCacheKey?: string;
  protocol?: ProviderProtocol;
  /** Dynamic OAuth access-token loader/refresh hook for ChatGPT Codex requests. */
  openAICodexAuth?: OpenAICodexAuthAdapter;
}

export function createUnavailableProvider(message: string): Provider {
  async function* streamChat(): AsyncIterable<StreamChunk> {
    throw new Error(message);
  }

  async function complete(): Promise<string> {
    throw new Error(message);
  }

  return { streamChat, complete };
}

export function createProviderInstance(options: ProviderInstanceOptions): Provider {
  if (resolveProviderProtocol(options) === "anthropic-messages") {
    return createAnthropicMessagesProvider(options);
  }

  if (isOpenAICodexBaseUrl(options.baseURL)) {
    return createOpenAICodexProvider({
      ...options,
      providerId: options.providerId || "openai-codex",
      auth: options.openAICodexAuth,
    });
  }

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  const fallbackModel = "gpt-4o";

  async function* streamChat(
    messages: ProviderMessage[],
    chatOptions: { model: string; tools?: ToolDefinition[]; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal }
  ): AsyncIterable<StreamChunk> {
    const requestConfig = resolveProviderRequestConfig(
      options.providerId || "",
      chatOptions.model,
      chatOptions.thinkingLevel ?? options.thinkingLevel ?? "off",
    );
    const tools = chatOptions.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as any,
      },
    }));

    const body: any = {
      model: chatOptions.model,
      messages: messages.map((message) => toChatCompletionsMessage(message, {
        reasoningContentEcho: requestConfig.reasoningContentEcho ?? "tool_calls",
      })),
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? "auto" : undefined,
      stream: true,
    };
    // DeepSeek and MiniMax only emit final usage in streaming mode when this flag is set.
    if (options.providerId === "deepseek" || options.providerId === "minimax") {
      body.stream_options = { include_usage: true };
    }
    if (!requestConfig.omitTemperature) {
      body.temperature = chatOptions.temperature ?? 0.2;
    }

    if (requestConfig.extraBody) {
      Object.assign(body, requestConfig.extraBody);
    }

    if (tools && tools.length > 0 && requestConfig.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = requestConfig.parallelToolCalls;
    }

    if (requestConfig.maxTokens !== undefined) {
      body.max_tokens = requestConfig.maxTokens;
    }

    if (requestConfig.reasoningEffort && requestConfig.reasoningEffort !== "off") {
      body.reasoning = { enabled: true };
    }

    const stream = (await client.chat.completions.create(body as any, {
      signal: chatOptions.abortSignal,
    } as any)) as any;

    yield* translateOpenAIStream(stream, {
      toolArgsMergeMode: resolveToolArgsMergeMode(options.providerId || "", options.baseURL),
      reasoningMergeMode: resolveReasoningMergeMode(options.providerId || "", options.baseURL),
      textMergeMode: resolveTextMergeMode(options.providerId || "", options.baseURL),
      debugProviderId: options.providerId || "",
      debugModelId: chatOptions.model,
    });

    yield { type: "done" };
  }

  async function complete(messages: ProviderMessage[], chatOptions?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal }): Promise<string> {
    const requestConfig = resolveProviderRequestConfig(
      options.providerId || "",
      chatOptions?.model ?? fallbackModel,
      chatOptions?.thinkingLevel ?? options.thinkingLevel ?? "off",
    );
    const body: any = {
      model: chatOptions?.model ?? fallbackModel,
      messages: messages.map((message) => toChatCompletionsMessage(message, {
        reasoningContentEcho: requestConfig.reasoningContentEcho ?? "tool_calls",
      })),
    };
    if (!requestConfig.omitTemperature) {
      body.temperature = chatOptions?.temperature ?? 0.2;
    }

    if (requestConfig.extraBody) {
      Object.assign(body, requestConfig.extraBody);
    }

    if (requestConfig.maxTokens !== undefined) {
      body.max_tokens = requestConfig.maxTokens;
    }

    if (requestConfig.reasoningEffort && requestConfig.reasoningEffort !== "off") {
      body.reasoning = { enabled: true };
    }
    const response = await client.chat.completions.create(body, {
      signal: chatOptions?.abortSignal,
    } as any);
    return response.choices[0]?.message?.content ?? "";
  }

  return { streamChat, complete };
}

function resolveProviderProtocol(options: ProviderInstanceOptions): ProviderProtocol {
  if (options.protocol) return options.protocol;
  const providerId = (options.providerId || "").toLowerCase();
  const baseURL = options.baseURL.toLowerCase();
  if (
    providerId === "anthropic"
    || providerId.endsWith("-anthropic")
    || baseURL.includes("/anthropic")
  ) {
    return "anthropic-messages";
  }
  return "openai-chat";
}

// Some providers (notably Fireworks-hosted Kimi) stream tool-call arguments
// as repeated full snapshots in each delta instead of incremental chunks, so
// a naive `+=` produces `{"x":1}{"x":1}` — not valid JSON. Parse the raw
// stream; if it doesn't parse but contains a balanced `{…}` prefix or suffix
// that does, use that. Empty or unsalvageable input becomes `"{}"` so the
// downstream echo to the model is always valid JSON.
//
// `corrupt` is set when the original raw was non-empty but unsalvageable,
// signalling that the model's intended arguments were lost in transport;
// downstream code should refuse to execute the call instead of silently
// running with an empty args object.
export interface NormalizedToolArgs {
  args: string;
  corrupt: boolean;
}

export function normalizeToolArgsDetailed(raw: string): NormalizedToolArgs {
  const s = (raw ?? "").trim();
  if (!s) {
    debugToolArgs({ stage: "normalize", input: raw, output: "{}", reason: "empty" });
    return { args: "{}", corrupt: false };
  }
  try { JSON.parse(s); debugToolArgs({ stage: "normalize", input: raw, output: s, reason: "passthrough" }); return { args: s, corrupt: false }; } catch {}

  const firstBrace = extractBalancedJson(s, 0);
  if (firstBrace) {
    try { JSON.parse(firstBrace); } catch {
      debugToolArgs({ stage: "normalize", input: raw, output: "{}", reason: "first-brace-unparseable", firstBrace });
      return { args: "{}", corrupt: true };
    }
    // If the content after the first balanced object is another valid object
    // with the same parse, we've got a snapshot duplication — keep one copy.
    const rest = s.slice(firstBrace.length).trim();
    if (!rest) {
      debugToolArgs({ stage: "normalize", input: raw, output: firstBrace, reason: "single-brace" });
      return { args: firstBrace, corrupt: false };
    }
    try { JSON.parse(rest); debugToolArgs({ stage: "normalize", input: raw, output: firstBrace, reason: "snapshot-dedup", rest }); return { args: firstBrace, corrupt: false }; } catch {}
    debugToolArgs({ stage: "normalize", input: raw, output: firstBrace, reason: "trailing-junk-dropped", rest });
    return { args: firstBrace, corrupt: false };
  }
  debugToolArgs({ stage: "normalize", input: raw, output: "{}", reason: "no-balanced-json" });
  return { args: "{}", corrupt: true };
}

export function normalizeToolArgs(raw: string): string {
  return normalizeToolArgsDetailed(raw).args;
}

function resolveToolArgsMergeMode(providerId: string, baseURL: string): ToolArgsMergeMode {
  const id = providerId.toLowerCase();
  const url = baseURL.toLowerCase();
  // Fireworks-hosted Kimi has been observed to stream cumulative snapshots
  // rather than OpenAI-style argument deltas.
  if (id === "fireworks" || url.includes("fireworks.ai")) return "snapshot";
  return "delta";
}

function resolveReasoningMergeMode(providerId: string, baseURL: string): ToolArgsMergeMode {
  const id = providerId.toLowerCase();
  const url = baseURL.toLowerCase();
  if (id === "fireworks" || url.includes("fireworks.ai")) return "snapshot";
  if (id === "minimax" || url.includes("api.minimaxi.com") || url.includes("api.minimax.io")) return "snapshot";
  return "delta";
}

function resolveTextMergeMode(providerId: string, baseURL: string): ToolArgsMergeMode {
  const id = providerId.toLowerCase();
  const url = baseURL.toLowerCase();
  if (id === "minimax" || url.includes("api.minimaxi.com") || url.includes("api.minimax.io")) return "snapshot";
  return "delta";
}

function extractBalancedJson(s: string, start: number): string | null {
  if (s[start] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Convert an OpenAI-compatible chat-completions stream into our internal StreamChunk events.
 *
 * Multi-tool-call streams are tracked by `index`, but tool-call starts and
 * argument deltas are emitted as soon as they arrive so the TUI can render
 * partial write previews before the tool executes. End events are still flushed
 * in index order to keep multi-call turns deterministic.
 */
export async function* translateOpenAIStream(
  stream: AsyncIterable<any>,
  options: TranslateOpenAIStreamOptions = {},
): AsyncIterable<StreamChunk> {
  const toolCalls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
  const textFilter = createProviderProtocolArtifactFilter();
  const toolArgsMergeMode = options.toolArgsMergeMode ?? "delta";
  const reasoningMergeMode = options.reasoningMergeMode ?? "delta";
  const textMergeMode = options.textMergeMode ?? "delta";
  let reasoningBuffer = "";
  let textBuffer = "";
  let rawChunkSeq = 0;
  // DeepSeek (and some inference re-hosts) sometimes deliver reasoning twice:
  // once via a dedicated `reasoning_content` / `thinking` field, and again
  // embedded as `<think>...</think>` inside `delta.content`. Track whether we
  // have seen the dedicated channel; if yes, strip <think> blocks from text
  // silently instead of yielding a second reasoning_delta.
  let hasDedicatedReasoningChannel = false;

  function* flushToolCalls(): Generator<StreamChunk> {
    if (toolCalls.size === 0) return;
    const sorted = [...toolCalls.entries()].sort(([a], [b]) => a - b);
    for (const [, entry] of sorted) {
      if (!entry.id || !entry.name) continue;
      if (!entry.started) {
        yield { type: "tool_call", id: entry.id, name: entry.name, arguments: "", isStart: true, isEnd: false };
        entry.started = true;
        if (entry.args) {
          yield { type: "tool_call", id: entry.id, name: entry.name, arguments: entry.args, isStart: false, isEnd: false };
        }
      }
      const normalized = normalizeToolArgsDetailed(entry.args);
      debugToolArgs({ stage: "flush-end", id: entry.id, name: entry.name, entryArgs: entry.args, finalArgs: normalized.args, corrupt: normalized.corrupt });
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
    toolCalls.clear();
  }

  function* startToolCallIfReady(entry: { id: string; name: string; args: string; started: boolean }): Generator<StreamChunk> {
    if (entry.started || !entry.id || !entry.name) return;
    entry.started = true;
    yield { type: "tool_call", id: entry.id, name: entry.name, arguments: "", isStart: true, isEnd: false };
    if (entry.args) {
      yield { type: "tool_call", id: entry.id, name: entry.name, arguments: entry.args, isStart: false, isEnd: false };
    }
  }

  for await (const chunk of stream) {
    rawChunkSeq += 1;
    const delta = chunk.choices?.[0]?.delta;
    const usage = (chunk as any).usage;
    const finishReason = chunk.choices?.[0]?.finish_reason;

    debugReasoningStream({
      stage: "provider_raw",
      providerId: options.debugProviderId,
      modelId: options.debugModelId,
      chunkSeq: rawChunkSeq,
      finishReason,
      content: summarizeDebugText(delta?.content),
      reasoning: summarizeDebugText((delta as any)?.reasoning),
      thinking: summarizeDebugText((delta as any)?.thinking),
      reasoningContent: summarizeDebugText((delta as any)?.reasoning_content),
      reasoningDetails: summarizeDebugText(extractReasoningDetailsText((delta as any)?.reasoning_details)),
    });

    if (usage) {
      yield {
        type: "usage",
        usage: {
          promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
          completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
          promptCacheHitTokens: typeof usage.prompt_cache_hit_tokens === "number"
            ? usage.prompt_cache_hit_tokens
            : typeof usage.prompt_tokens_details?.cached_tokens === "number"
              ? usage.prompt_tokens_details.cached_tokens
              : undefined,
          promptCacheMissTokens: typeof usage.prompt_cache_miss_tokens === "number"
            ? usage.prompt_cache_miss_tokens
            : typeof usage.prompt_tokens_details?.cached_tokens === "number" && typeof usage.prompt_tokens === "number"
              ? Math.max(0, usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens)
              : undefined,
          reasoningTokens: typeof usage.completion_tokens_details?.reasoning_tokens === "number"
            ? usage.completion_tokens_details.reasoning_tokens
            : undefined,
          totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
        },
      };
    }

    const reasoningDetails = extractReasoningDetailsText((delta as any)?.reasoning_details);
    const reasoningField = reasoningDetails !== undefined
      ? "reasoning_details"
      : (delta as any)?.reasoning !== undefined
      ? "reasoning"
      : (delta as any)?.thinking !== undefined
        ? "thinking"
        : (delta as any)?.reasoning_content !== undefined
          ? "reasoning_content"
          : undefined;
    const reasoning = reasoningDetails !== undefined
      ? reasoningDetails
      : reasoningField
        ? (delta as any)[reasoningField]
        : undefined;
    if (reasoning) {
      hasDedicatedReasoningChannel = true;
      const merged = mergeStreamingText(reasoningBuffer, reasoning, reasoningMergeMode);
      reasoningBuffer = merged.args;
      debugReasoningStream({
        stage: "provider_emit",
        providerId: options.debugProviderId,
        modelId: options.debugModelId,
        chunkSeq: rawChunkSeq,
        source: reasoningField,
        mergeMode: reasoningMergeMode,
        suppressed: !merged.delta,
        emitted: summarizeDebugText(merged.delta),
        buffer: summarizeDebugText(reasoningBuffer),
      });
      if (merged.delta) {
        yield { type: "reasoning_delta", content: merged.delta };
      }
    }

    if (delta?.content) {
      const mergedContent = mergeStreamingText(textBuffer, delta.content, textMergeMode);
      textBuffer = mergedContent.args;
      const content = mergedContent.delta;
      if (content) {
        const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
        if (thinkMatch) {
          if (thinkMatch[1] && !hasDedicatedReasoningChannel) {
            const merged = mergeStreamingText(reasoningBuffer, thinkMatch[1], reasoningMergeMode);
            reasoningBuffer = merged.args;
            debugReasoningStream({
              stage: "provider_emit",
              providerId: options.debugProviderId,
              modelId: options.debugModelId,
              chunkSeq: rawChunkSeq,
              source: "content_think",
              mergeMode: reasoningMergeMode,
              suppressed: !merged.delta,
              emitted: summarizeDebugText(merged.delta),
              buffer: summarizeDebugText(reasoningBuffer),
            });
            if (merged.delta) {
              yield { type: "reasoning_delta", content: merged.delta };
            }
          }
          const remaining = content.replace(/<think>[\s\S]*?<\/think>/, "");
          const cleaned = textFilter.push(remaining);
          if (cleaned) {
            yield { type: "text", content: cleaned };
          }
        } else {
          const cleaned = textFilter.push(content);
          if (cleaned) {
            yield { type: "text", content: cleaned };
          }
        }
      }
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: "", name: "", args: "", started: false };
          toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        yield* startToolCallIfReady(entry);
        if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
          debugToolArgs({ stage: "raw-chunk", id: entry.id, name: entry.name, idx, raw: tc.function.arguments });
          const merged = mergeToolArgumentDelta(entry.args, tc.function.arguments, toolArgsMergeMode);
          entry.args = merged.args;
          if (entry.started && merged.delta) {
            yield {
              type: "tool_call",
              id: entry.id,
              name: entry.name,
              arguments: merged.delta,
              isStart: false,
              isEnd: false,
            };
          }
        }
      }
    }

    if (finishReason === "tool_calls") {
      yield* flushToolCalls();
    }
  }

  const remainingText = textFilter.flush();
  if (remainingText) {
    yield { type: "text", content: remainingText };
  }
  yield* flushToolCalls();
}

function extractReasoningDetailsText(value: unknown): string | undefined {
  if (!value) return undefined;
  const details = Array.isArray(value) ? value : [value];
  const parts = details.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const text = record.text ?? record.thinking ?? record.content;
    return typeof text === "string" ? [text] : [];
  });
  return parts.length > 0 ? parts.join("") : undefined;
}

function mergeToolArgumentDelta(current: string, incoming: string, mode: ToolArgsMergeMode): { args: string; delta: string } {
  if (!current) {
    debugToolArgs({ stage: "merge", branch: "empty-current", current, incoming, args: incoming, delta: incoming });
    return { args: incoming, delta: incoming };
  }
  if (!incoming) {
    debugToolArgs({ stage: "merge", branch: "empty-incoming", current, incoming, args: current, delta: "" });
    return { args: current, delta: "" };
  }

  if (mode === "snapshot") {
    // Snapshot streams repeat the current full argument buffer. Only treat a
    // chunk as duplicate when it is exactly equal, or as growth when it carries
    // the current buffer as a prefix. A suffix match is not enough: the next
    // legitimate delta can be a single trailing character like "0".
    if (incoming === current) {
      debugToolArgs({ stage: "merge", branch: "snapshot-dup", current, incoming, args: current, delta: "" });
      return { args: current, delta: "" };
    }
    if (incoming.startsWith(current)) {
      const delta = incoming.slice(current.length);
      debugToolArgs({ stage: "merge", branch: "snapshot-grow", current, incoming, args: incoming, delta });
      return { args: incoming, delta };
    }
  }

  debugToolArgs({ stage: "merge", branch: mode === "delta" ? "delta-append" : "snapshot-fallback-concat", current, incoming, args: current + incoming, delta: incoming });
  return { args: current + incoming, delta: incoming };
}

function mergeStreamingText(current: string, incoming: string, mode: ToolArgsMergeMode): { args: string; delta: string } {
  if (!current) return { args: incoming, delta: incoming };
  if (!incoming) return { args: current, delta: "" };
  if (mode === "snapshot") {
    if (incoming === current) return { args: current, delta: "" };
    if (incoming.startsWith(current)) return { args: incoming, delta: incoming.slice(current.length) };
  }
  return { args: current + incoming, delta: incoming };
}

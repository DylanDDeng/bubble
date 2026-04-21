/**
 * OpenAI-compatible Provider implementation.
 *
 * Works with OpenRouter, OpenAI, DeepSeek, Google, Groq, Together, and local OpenAI-compatible endpoints.
 */

import OpenAI from "openai";
import { createOpenAICodexProvider, isOpenAICodexBaseUrl } from "./provider-openai-codex.js";
import { resolveProviderRequestConfig } from "./provider-transform.js";
import type { Message, Provider, StreamChunk, ThinkingLevel, ToolDefinition } from "./types.js";

function toChatCompletionsMessage(message: Message): Record<string, unknown> {
  if (message.role === "assistant") {
    const out: Record<string, unknown> = {
      role: "assistant",
      content: message.content || null,
    };
    if (message.toolCalls && message.toolCalls.length > 0) {
      out.tool_calls = message.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      }));
      // Kimi-k2.5 with thinking enabled requires reasoning_content to be echoed
      // back on assistant messages that carry tool_calls. Harmless for other providers.
      if (message.reasoning) {
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
  if (isOpenAICodexBaseUrl(options.baseURL)) {
    return createOpenAICodexProvider({ ...options, providerId: options.providerId || "openai-codex" });
  }

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  const fallbackModel = "gpt-4o";

  async function* streamChat(
    messages: Message[],
    chatOptions: { model: string; tools?: ToolDefinition[]; temperature?: number; thinkingLevel?: ThinkingLevel }
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
      messages: messages.map(toChatCompletionsMessage),
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? "auto" : undefined,
      stream: true,
    };
    if (!requestConfig.omitTemperature) {
      body.temperature = chatOptions.temperature ?? 0.2;
    }

    if (requestConfig.extraBody) {
      Object.assign(body, requestConfig.extraBody);
    }

    if (requestConfig.reasoningEffort && requestConfig.reasoningEffort !== "off") {
      body.reasoning = { enabled: true };
    }

    const stream = (await client.chat.completions.create(body as any)) as any;

    yield* translateOpenAIStream(stream);

    yield { type: "done" };
  }

  async function complete(messages: Message[], chatOptions?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel }): Promise<string> {
    const requestConfig = resolveProviderRequestConfig(
      options.providerId || "",
      chatOptions?.model ?? fallbackModel,
      chatOptions?.thinkingLevel ?? options.thinkingLevel ?? "off",
    );
    const body: any = {
      model: chatOptions?.model ?? fallbackModel,
      messages: messages.map(toChatCompletionsMessage),
    };
    if (!requestConfig.omitTemperature) {
      body.temperature = chatOptions?.temperature ?? 0.2;
    }

    if (requestConfig.extraBody) {
      Object.assign(body, requestConfig.extraBody);
    }

    if (requestConfig.reasoningEffort && requestConfig.reasoningEffort !== "off") {
      body.reasoning = { enabled: true };
    }
    const response = await client.chat.completions.create(body);
    return response.choices[0]?.message?.content ?? "";
  }

  return { streamChat, complete };
}

// Some providers (notably Fireworks-hosted Kimi) stream tool-call arguments
// as repeated full snapshots in each delta instead of incremental chunks, so
// a naive `+=` produces `{"x":1}{"x":1}` — not valid JSON. Parse the raw
// stream; if it doesn't parse but contains a balanced `{…}` prefix or suffix
// that does, use that. Empty or unsalvageable input becomes `"{}"` so the
// downstream echo to the model is always valid JSON.
export function normalizeToolArgs(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "{}";
  try { JSON.parse(s); return s; } catch {}

  const firstBrace = extractBalancedJson(s, 0);
  if (firstBrace) {
    try { JSON.parse(firstBrace); } catch { return "{}"; }
    // If the content after the first balanced object is another valid object
    // with the same parse, we've got a snapshot duplication — keep one copy.
    const rest = s.slice(firstBrace.length).trim();
    if (!rest) return firstBrace;
    try { JSON.parse(rest); return firstBrace; } catch {}
    return firstBrace;
  }
  return "{}";
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
 * Multi-tool-call streams are buffered by `index` and emitted in index order at
 * `finish_reason === "tool_calls"`, so the agent layer always sees a clean
 * (isStart -> args -> isEnd) sequence per call. This matters for providers like
 * Kimi K2.5 that emit several parallel tool calls per assistant turn -- the
 * previous single-slot implementation silently dropped every call but the last.
 */
export async function* translateOpenAIStream(stream: AsyncIterable<any>): AsyncIterable<StreamChunk> {
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  function* flushToolCalls(): Generator<StreamChunk> {
    if (toolCalls.size === 0) return;
    const sorted = [...toolCalls.entries()].sort(([a], [b]) => a - b);
    for (const [, entry] of sorted) {
      if (!entry.id || !entry.name) continue;
      const args = normalizeToolArgs(entry.args);
      yield { type: "tool_call", id: entry.id, name: entry.name, arguments: "", isStart: true, isEnd: false };
      yield { type: "tool_call", id: entry.id, name: entry.name, arguments: args, isStart: false, isEnd: false };
      yield { type: "tool_call", id: entry.id, name: entry.name, arguments: "", isStart: false, isEnd: true };
    }
    toolCalls.clear();
  }

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    const usage = (chunk as any).usage;

    if (usage) {
      yield { type: "usage", promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
    }

    const reasoning = (delta as any)?.reasoning ?? (delta as any)?.thinking ?? (delta as any)?.reasoning_content;
    if (reasoning) {
      yield { type: "reasoning_delta", content: reasoning };
    }

    if (delta?.content) {
      const thinkMatch = delta.content.match(/<think>([\s\S]*?)<\/think>/);
      if (thinkMatch) {
        if (thinkMatch[1]) {
          yield { type: "reasoning_delta", content: thinkMatch[1] };
        }
        const remaining = delta.content.replace(/<think>[\s\S]*?<\/think>/, "");
        if (remaining) {
          yield { type: "text", content: remaining };
        }
      } else {
        yield { type: "text", content: delta.content };
      }
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: "", name: "", args: "" };
          toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") entry.args += tc.function.arguments;
      }
    }

    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason === "tool_calls") {
      yield* flushToolCalls();
    }
  }

  yield* flushToolCalls();
}

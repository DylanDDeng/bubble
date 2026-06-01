import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicRequest, translateAnthropicStream } from "../provider-anthropic.js";
import { createProviderInstance } from "../provider.js";
import type { StreamChunk, ToolDefinition } from "../types.js";

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function makeSseResponse(events: object[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const readTool: ToolDefinition = {
  name: "read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

describe("provider-anthropic", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts Bubble history into Anthropic Messages blocks", () => {
    const body = buildAnthropicRequest({
      providerId: "minimax",
      apiKey: "sk-test",
      baseURL: "https://api.minimaxi.com/anthropic",
      thinkingLevel: "medium",
    }, [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "I will read.",
        reasoning: "Need the file first.",
        toolCalls: [{ id: "read:1", name: "read", arguments: "{\"path\":\"a.ts\"}" }],
      },
      { role: "tool", toolCallId: "read:1", content: "ok" },
    ], {
      model: "MiniMax-M3",
      tools: [readTool],
      stream: true,
      thinkingLevel: "medium",
    });

    expect(body.system).toBe("system prompt");
    expect(body.tools).toEqual([{
      name: "read",
      description: "Read a file",
      input_schema: readTool.parameters,
    }]);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need the file first." },
          { type: "text", text: "I will read." },
          { type: "tool_use", id: "read:1", name: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read:1", content: "ok" }],
      },
    ]);
  });

  it("replays raw Anthropic blocks with signatures instead of sanitized reasoning", () => {
    const body = buildAnthropicRequest({
      providerId: "minimax",
      apiKey: "sk-test",
      baseURL: "https://api.minimaxi.com/anthropic",
      thinkingLevel: "medium",
    }, [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "I will read.",
        reasoning: "sanitized thinking",
        toolCalls: [{ id: "read:1", name: "read", arguments: "{\"path\":\"a.ts\"}" }],
        providerMetadata: {
          anthropic: {
            contentBlocks: [
              { type: "thinking", thinking: "raw thinking Runtime reminder:\nkeep original", signature: "sig_123" },
              { type: "text", text: "I will read." },
              { type: "tool_use", id: "read:1", name: "read", input: { path: "a.ts" } },
            ],
          },
        },
      },
      { role: "tool", toolCallId: "read:1", content: "ok" },
    ], {
      model: "MiniMax-M3",
      tools: [readTool],
      stream: true,
      thinkingLevel: "medium",
    });

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "raw thinking Runtime reminder:\nkeep original", signature: "sig_123" },
        { type: "text", text: "I will read." },
        { type: "tool_use", id: "read:1", name: "read", input: { path: "a.ts" } },
      ],
    });
  });

  it("does not replay thinking from older non-tool turns", () => {
    const body = buildAnthropicRequest({
      providerId: "minimax",
      apiKey: "sk-test",
      baseURL: "https://api.minimaxi.com/anthropic",
      thinkingLevel: "medium",
    }, [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer", reasoning: "old hidden reasoning" },
      { role: "user", content: "new task" },
      {
        role: "assistant",
        content: "",
        reasoning: "current tool reasoning",
        toolCalls: [{ id: "read:1", name: "read", arguments: "{\"path\":\"a.ts\"}" }],
      },
      { role: "tool", toolCallId: "read:1", content: "ok" },
    ], {
      model: "MiniMax-M3",
      tools: [readTool],
      stream: true,
      thinkingLevel: "medium",
    });

    expect(body.messages).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: "new task" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "current tool reasoning" },
          { type: "tool_use", id: "read:1", name: "read", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read:1", content: "ok" }] },
    ]);
  });

  it("streams Anthropic text, thinking, tool calls, and cumulative usage", async () => {
    const chunks = await collect(translateAnthropicStream(fromArray([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 40,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Plan" } },
      { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig_plan" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ".ts\"}" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ])));

    expect(chunks.filter((chunk) => chunk.type === "text").map((chunk: any) => chunk.content).join("")).toBe("Hello");
    expect(chunks.filter((chunk) => chunk.type === "reasoning_delta").map((chunk: any) => chunk.content).join("")).toBe("Plan");
    expect(chunks.filter((chunk) => chunk.type === "provider_content_block")).toEqual([
      { type: "provider_content_block", provider: "anthropic", block: { type: "text", text: "Hello" } },
      { type: "provider_content_block", provider: "anthropic", block: { type: "thinking", thinking: "Plan", signature: "sig_plan" } },
      { type: "provider_content_block", provider: "anthropic", block: { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } } },
    ]);
    expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
      { type: "tool_call", id: "toolu_1", name: "read", arguments: "", isStart: true, isEnd: false },
      { type: "tool_call", id: "toolu_1", name: "read", arguments: "{\"path\":\"a", isStart: false, isEnd: false },
      { type: "tool_call", id: "toolu_1", name: "read", arguments: ".ts\"}", isStart: false, isEnd: false },
      { type: "tool_call", id: "toolu_1", name: "read", arguments: "", argumentsFull: "{\"path\":\"a.ts\"}", isStart: false, isEnd: true },
    ]);
    expect(chunks.filter((chunk) => chunk.type === "usage").at(-1)).toEqual({
      type: "usage",
      usage: {
        promptTokens: 140,
        completionTokens: 12,
        promptCacheHitTokens: 40,
        promptCacheMissTokens: 100,
        totalTokens: 152,
      },
    });
  });

  it("dispatches Anthropic protocol providers through the Messages endpoint", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return makeSseResponse([
        { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_stop" },
      ]);
    }));

    const provider = createProviderInstance({
      providerId: "minimax",
      apiKey: "sk-test",
      baseURL: "https://api.minimaxi.com/anthropic",
      protocol: "anthropic-messages",
    });

    const chunks = await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "MiniMax-M3",
      tools: [readTool],
      thinkingLevel: "medium",
    }));

    expect(requestUrl).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      accept: "text/event-stream",
    });
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: "MiniMax-M3",
      max_tokens: 8192,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read" }],
      stream: true,
      thinking: { type: "adaptive" },
    });
    expect(chunks.filter((chunk) => chunk.type === "text").map((chunk: any) => chunk.content).join("")).toBe("ok");
    expect(chunks.at(-1)).toEqual({ type: "done" });
  });

  it("retries MiniMax Anthropic 5xx before consuming the stream", async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "unknown error, 714 (1000)" },
        }), { status: 500 });
      }
      return makeSseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createProviderInstance({
      providerId: "minimax",
      apiKey: "sk-test",
      baseURL: "https://api.minimaxi.com/anthropic",
      protocol: "anthropic-messages",
    });

    const chunks = await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "MiniMax-M3",
      tools: [readTool],
      thinkingLevel: "medium",
    }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks.filter((chunk) => chunk.type === "text").map((chunk: any) => chunk.content).join("")).toBe("ok");
  });

  it("can infer Anthropic protocol from an /anthropic base URL", async () => {
    let requestUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      requestUrl = String(url);
      return makeSseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_stop" },
      ]);
    }));

    const provider = createProviderInstance({
      providerId: "custom-minimax",
      apiKey: "sk-test",
      baseURL: "https://api.example.com/anthropic",
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "future-model",
    }));

    expect(requestUrl).toBe("https://api.example.com/anthropic/v1/messages");
  });

  it("uses Anthropic API-key auth for the official Claude API", async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requestInit = init;
      return makeSseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_stop" },
      ]);
    }));

    const provider = createProviderInstance({
      providerId: "anthropic",
      apiKey: "sk-ant-test",
      baseURL: "https://api.anthropic.com",
      protocol: "anthropic-messages",
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "claude-opus-4-8",
    }));

    expect(requestInit?.headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
      accept: "text/event-stream",
    });
    expect(requestInit?.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(String(requestInit?.body))).not.toHaveProperty("temperature");
  });
});

import { describe, expect, it } from "vitest";
import { toChatCompletionsMessage, translateOpenAIStream } from "../provider.js";
import type { StreamChunk } from "../types.js";

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function startEnds(chunks: StreamChunk[]) {
  return chunks
    .filter((c): c is Extract<StreamChunk, { type: "tool_call" }> => c.type === "tool_call")
    .map((c) => ({ id: c.id, name: c.name, args: c.arguments, isStart: c.isStart, isEnd: c.isEnd }));
}

describe("toChatCompletionsMessage", () => {
  it("echoes reasoning content for DeepSeek-style thinking history", () => {
    expect(toChatCompletionsMessage({
      role: "assistant",
      content: "done",
      reasoning: "plan",
    }, { reasoningContentEcho: "all" })).toEqual({
      role: "assistant",
      content: "done",
      reasoning_content: "plan",
    });
  });

  it("keeps tool-call-only reasoning echo compatibility by default", () => {
    expect(toChatCompletionsMessage({
      role: "assistant",
      content: "",
      reasoning: "used tool",
      toolCalls: [{ id: "read:1", name: "read", arguments: "{\"path\":\"a\"}" }],
    })).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "used tool",
      tool_calls: [{
        id: "read:1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"a\"}" },
      }],
    });
  });

  it("does not echo normal assistant reasoning unless configured", () => {
    expect(toChatCompletionsMessage({
      role: "assistant",
      content: "done",
      reasoning: "plan",
    })).toEqual({
      role: "assistant",
      content: "done",
    });
  });
});

describe("translateOpenAIStream", () => {
  it("captures a single tool call streamed across chunks", async () => {
    const chunks = await collect(translateOpenAIStream(fromArray([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "write:1", function: { name: "write" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.html\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])));

    expect(startEnds(chunks)).toEqual([
      { id: "write:1", name: "write", args: "", isStart: true, isEnd: false },
      { id: "write:1", name: "write", args: "{\"path\":\"a.html\"}", isStart: false, isEnd: false },
      { id: "write:1", name: "write", args: "", isStart: false, isEnd: true },
    ]);
  });

  it("captures multiple parallel tool calls emitted across separate per-index chunks", async () => {
    // Reproduces the Kimi K2.5 multi-write pattern that previously dropped every call but the last.
    const chunks = await collect(translateOpenAIStream(fromArray([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "write:1", function: { name: "write" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":1}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "write:2", function: { name: "write" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "{\"b\":2}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 2, id: "write:3", function: { name: "write" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 2, function: { arguments: "{\"c\":3}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])));

    const events = startEnds(chunks);
    const ids = events.filter((e) => e.isEnd).map((e) => e.id);
    expect(ids).toEqual(["write:1", "write:2", "write:3"]);

    const argsById = new Map<string, string>();
    for (const e of events) {
      if (!e.isStart && !e.isEnd) argsById.set(e.id, e.args);
    }
    expect(argsById.get("write:1")).toBe("{\"a\":1}");
    expect(argsById.get("write:2")).toBe("{\"b\":2}");
    expect(argsById.get("write:3")).toBe("{\"c\":3}");
  });

  it("handles all parallel tool calls declared upfront in one chunk", async () => {
    const chunks = await collect(translateOpenAIStream(fromArray([
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: "write:1", function: { name: "write", arguments: "{\"a\":1}" } },
              { index: 1, id: "write:2", function: { name: "write", arguments: "{\"b\":2}" } },
              { index: 2, id: "write:3", function: { name: "write", arguments: "{\"c\":3}" } },
            ],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])));

    const ends = startEnds(chunks).filter((e) => e.isEnd).map((e) => e.id);
    expect(ends).toEqual(["write:1", "write:2", "write:3"]);
  });

  it("interleaves arg deltas across indices without misrouting", async () => {
    const chunks = await collect(translateOpenAIStream(fromArray([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "write:1", function: { name: "write" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "write:2", function: { name: "write" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "{\"b\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "2}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])));

    const argsById = new Map<string, string>();
    for (const e of startEnds(chunks)) {
      if (!e.isStart && !e.isEnd) argsById.set(e.id, e.args);
    }
    expect(argsById.get("write:1")).toBe("{\"a\":1}");
    expect(argsById.get("write:2")).toBe("{\"b\":2}");
  });

  it("forwards text and reasoning deltas alongside tool calls", async () => {
    const chunks = await collect(translateOpenAIStream(fromArray([
      { choices: [{ delta: { content: "hello " } }] },
      { choices: [{ delta: { reasoning: "thinking..." } }] },
      { choices: [{ delta: { content: "world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ])));

    expect(chunks.filter((c) => c.type === "text").map((c: any) => c.content).join("")).toBe("hello world");
    expect(chunks.find((c) => c.type === "reasoning_delta")).toEqual({ type: "reasoning_delta", content: "thinking..." });
  });

  it("forwards DeepSeek usage cache and reasoning token details", async () => {
    const chunks = await collect(translateOpenAIStream(fromArray([
      {
        usage: {
          prompt_tokens: 100,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
          completion_tokens: 20,
          total_tokens: 120,
          completion_tokens_details: { reasoning_tokens: 12 },
        },
        choices: [{ delta: {} }],
      },
    ])));

    expect(chunks).toContainEqual({
      type: "usage",
      usage: {
        promptTokens: 100,
        promptCacheHitTokens: 40,
        promptCacheMissTokens: 60,
        completionTokens: 20,
        totalTokens: 120,
        reasoningTokens: 12,
      },
    });
  });

  it("flushes pending tool calls if the stream ends without finish_reason=tool_calls", async () => {
    const chunks = await collect(translateOpenAIStream(fromArray([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "write:1", function: { name: "write", arguments: "{}" } }] } }] },
      { choices: [{ delta: {} }] },
    ])));

    const ends = startEnds(chunks).filter((e) => e.isEnd).map((e) => e.id);
    expect(ends).toEqual(["write:1"]);
  });
});

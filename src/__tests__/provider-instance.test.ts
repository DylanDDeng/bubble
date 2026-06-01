import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk, ToolDefinition } from "../types.js";

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function MockOpenAI() {
    return {
      chat: {
        completions: {
          create: createMock,
        },
      },
    };
  }),
}));

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("createProviderInstance", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("requests stream usage for DeepSeek so cost can be calculated", async () => {
    let body: any;
    createMock.mockImplementation(async (input) => {
      body = input;
      return fromArray([
        {
          usage: {
            prompt_tokens: 100,
            prompt_cache_hit_tokens: 40,
            prompt_cache_miss_tokens: 60,
            completion_tokens: 20,
          },
          choices: [{ delta: {} }],
        },
      ]);
    });

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "deepseek",
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com",
    });

    const chunks = await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "deepseek-v4-pro",
    }));

    expect(body.stream_options).toEqual({ include_usage: true });
    expect(chunks.some((chunk) => chunk.type === "usage")).toBe(true);
  });

  it("uses Fireworks Kimi request defaults", async () => {
    let body: any;
    createMock.mockImplementation(async (input) => {
      body = input;
      return fromArray([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "fireworks",
      apiKey: "sk-test",
      baseURL: "https://api.fireworks.ai/inference/v1",
    });

    await collect(provider.streamChat([{
      role: "assistant",
      content: "",
      reasoning: "tool reasoning",
      toolCalls: [{ id: "read:1", name: "read", arguments: "{\"path\":\"a\"}" }],
    }], {
      model: "accounts/fireworks/models/kimi-k2p6",
    }));

    expect(body.max_tokens).toBe(32768);
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.messages[0].reasoning_content).toBeUndefined();
  });

  it("uses StepFun Step Plan reasoning effort request shape", async () => {
    let body: any;
    createMock.mockImplementation(async (input) => {
      body = input;
      return fromArray([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "stepfun",
      apiKey: "sk-test",
      baseURL: "https://api.stepfun.com/step_plan/v1",
    });

    await collect(provider.streamChat([{
      role: "assistant",
      content: "",
      reasoning: "tool reasoning",
      toolCalls: [{ id: "read:1", name: "read", arguments: "{\"path\":\"a\"}" }],
    }], {
      model: "step-3.7-flash",
      thinkingLevel: "high",
    }));

    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
    expect(body.messages[0].reasoning_content).toBeUndefined();
  });

  it("uses MiniMax OpenAI-compatible interleaved thinking request shape", async () => {
    let body: any;
    createMock.mockImplementation(async (input) => {
      body = input;
      return fromArray([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "minimax",
      apiKey: "sk-test",
      baseURL: "https://api.minimaxi.com/v1",
    });

    await collect(provider.streamChat([{
      role: "assistant",
      content: "",
      reasoning: "tool reasoning",
      toolCalls: [{ id: "read:1", name: "read", arguments: "{\"path\":\"a\"}" }],
    }], {
      model: "MiniMax-M3",
      thinkingLevel: "medium",
    }));

    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning_split).toBe(true);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.reasoning).toBeUndefined();
    expect(body.messages[0].reasoning_details).toEqual([{
      type: "reasoning.text",
      id: "reasoning-text-1",
      format: "MiniMax-response-v1",
      index: 0,
      text: "tool reasoning",
    }]);
    expect(body.messages[0].reasoning_content).toBeUndefined();
  });

  it("disables parallel tool calls only for Fireworks Kimi when tools are available", async () => {
    const tool: ToolDefinition = {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };

    let fireworksBody: any;
    createMock.mockImplementation(async (input) => {
      fireworksBody = input;
      return fromArray([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });

    const { createProviderInstance } = await import("../provider.js");
    const fireworks = createProviderInstance({
      providerId: "fireworks",
      apiKey: "sk-test",
      baseURL: "https://api.fireworks.ai/inference/v1",
    });

    await collect(fireworks.streamChat([{ role: "user", content: "hi" }], {
      model: "accounts/fireworks/models/kimi-k2p6",
      tools: [tool],
    }));

    expect(fireworksBody.parallel_tool_calls).toBe(false);

    let openaiBody: any;
    createMock.mockImplementation(async (input) => {
      openaiBody = input;
      return fromArray([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });

    const openai = createProviderInstance({
      providerId: "openai",
      apiKey: "sk-test",
      baseURL: "https://api.openai.com/v1",
    });

    await collect(openai.streamChat([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      tools: [tool],
    }));

    expect(openaiBody.parallel_tool_calls).toBeUndefined();
  });
});

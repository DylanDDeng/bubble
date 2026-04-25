import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../types.js";

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
});

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

function makeSseResponse(events: Array<Record<string, unknown>>): Response {
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

describe("createProviderInstance", () => {
  beforeEach(() => {
    createMock.mockReset();
    vi.unstubAllGlobals();
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

  it.each([
    ["openai", "https://api.openai.com/v1", "gpt-4o"],
    ["moonshot-cn", "https://api.moonshot.cn/v1", "kimi-k2.7-code"],
    ["moonshot-intl", "https://api.moonshot.ai/v1", "kimi-k2.7-code"],
    ["zhipuai", "https://open.bigmodel.cn/api/paas/v4", "glm-5.2"],
    ["zai-coding-plan", "https://api.z.ai/api/coding/paas/v4", "glm-5.2"],
  ])("requests stream usage for %s-compatible streaming", async (providerId, baseURL, model) => {
    let body: any;
    createMock.mockImplementation(async (input) => {
      body = input;
      return fromArray([
        {
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
          },
          choices: [{ delta: {} }],
        },
      ]);
    });

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId,
      apiKey: "sk-test",
      baseURL,
    });

    const chunks = await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model,
    }));

    expect(body.stream_options).toEqual({ include_usage: true });
    expect(chunks).toContainEqual({
      type: "usage",
      usage: {
        promptTokens: 12,
        completionTokens: 3,
        promptCacheHitTokens: undefined,
        promptCacheMissTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: undefined,
      },
    });
  });

  it("preserves OpenAI-compatible tools while disabling tool calls", async () => {
    let body: any;
    createMock.mockImplementation(async (input) => {
      body = input;
      return fromArray([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    });

    const readTool: ToolDefinition = {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };
    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "openai",
      apiKey: "sk-test",
      baseURL: "https://api.openai.com/v1",
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      tools: [readTool],
      toolChoice: "none",
    }));

    expect(body.tools?.map((tool: any) => tool.function.name)).toEqual(["read"]);
    expect(body.tool_choice).toBe("none");
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

  it("uses Volcengine Ark Responses API for Doubao", async () => {
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInits.push(init ?? {});
      return makeSseResponse([
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              output_tokens_details: { reasoning_tokens: 2 },
              total_tokens: 15,
            },
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "doubao",
      apiKey: "sk-test",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    });

    await collect(provider.streamChat([{
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "https://arkdoc.tos-cn-beijing.volces.com/images/get-started/project-demo.png" },
        },
        {
          type: "text",
          text: "请根据图片实现一个短视频网站首页项目。",
        },
      ],
    }], {
      model: "doubao-seed-2-1-pro-260628",
      thinkingLevel: "high",
    }));

    const body = JSON.parse(String(requestInits[0].body));
    expect(fetchMock).toHaveBeenCalledWith("https://ark.cn-beijing.volces.com/api/v3/responses", expect.any(Object));
    expect(createMock).not.toHaveBeenCalled();
    expect(body.model).toBe("doubao-seed-2-1-pro-260628");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.input[0].content).toEqual([
      {
        type: "input_image",
        image_url: "https://arkdoc.tos-cn-beijing.volces.com/images/get-started/project-demo.png",
      },
      {
        type: "input_text",
        text: "请根据图片实现一个短视频网站首页项目。",
      },
    ]);
  });

  it("maps Doubao minimal reasoning to disabled Ark thinking", async () => {
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInits.push(init ?? {});
      return makeSseResponse([{ type: "response.completed", response: {} }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "doubao",
      apiKey: "sk-test",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], {
      model: "doubao-seed-2-1-pro-260628",
      thinkingLevel: "minimal",
    }));

    const body = JSON.parse(String(requestInits[0].body));
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("streams tool calls through Doubao Ark Responses API", async () => {
    const writeTool: ToolDefinition = {
      name: "write",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    };
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInits.push(init ?? {});
      return makeSseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_write",
            name: "write",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: "{\"path\":\"index.html\",",
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: "\"content\":\"<html></html>\"}",
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: "{\"path\":\"index.html\",\"content\":\"<html></html>\"}",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_write",
            name: "write",
            arguments: "{\"path\":\"index.html\",\"content\":\"<html></html>\"}",
          },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
            },
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "doubao",
      apiKey: "sk-test",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    });

    const chunks = await collect(provider.streamChat([{ role: "user", content: "write a file" }], {
      model: "doubao-seed-2-1-pro-260628",
      thinkingLevel: "high",
      tools: [writeTool],
    }));

    const body = JSON.parse(String(requestInits[0].body));
    expect(body.stream).toBe(true);
    expect(body.tools?.map((tool: any) => tool.name)).toEqual(["write"]);
    expect(body.tools[0].parameters).toEqual(writeTool.parameters);
    expect(body.reasoning_effort).toBeUndefined();

    expect(chunks).toContainEqual({
      type: "usage",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        promptCacheHitTokens: undefined,
        promptCacheMissTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: 15,
      },
    });
    expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_write", name: "write", arguments: "", isStart: true, isEnd: false },
      {
        type: "tool_call",
        id: "call_write",
        name: "write",
        arguments: "{\"path\":\"index.html\",",
        isStart: false,
        isEnd: false,
      },
      {
        type: "tool_call",
        id: "call_write",
        name: "write",
        arguments: "\"content\":\"<html></html>\"}",
        isStart: false,
        isEnd: false,
      },
      {
        type: "tool_call",
        id: "call_write",
        name: "write",
        arguments: "",
        argumentsFull: "{\"path\":\"index.html\",\"content\":\"<html></html>\"}",
        argumentsCorrupt: undefined,
        isStart: false,
        isEnd: true,
      },
    ]);
    expect(chunks.at(-1)).toEqual({ type: "done" });
  });

  it("marks malformed Doubao Ark Responses tool calls as corrupt", async () => {
    const writeTool: ToolDefinition = {
      name: "write",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    };

    const fetchMock = vi.fn(async () => makeSseResponse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_write",
          name: "write",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "{\"path\":\"index.html\",\"content\":\"",
      },
      {
        type: "response.incomplete",
        response: {},
      },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "doubao",
      apiKey: "sk-test",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    });

    const chunks = await collect(provider.streamChat([{ role: "user", content: "write a file" }], {
      model: "doubao-seed-2-1-pro-260628",
      thinkingLevel: "high",
      tools: [writeTool],
    }));

    expect(chunks.filter((chunk) => chunk.type === "tool_call").at(-1)).toEqual({
      type: "tool_call",
      id: "call_write",
      name: "write",
      arguments: "",
      argumentsFull: "{}",
      argumentsCorrupt: true,
      isStart: false,
      isEnd: true,
    });
  });

  it("disables parallel tool calls for providers that require serialized tool calls", async () => {
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
  it("sends user-configured headers on the generic chat path", async () => {
    createMock.mockResolvedValue(fromArray([]));
    const { createProviderInstance } = await import("../provider.js");
    const OpenAI = (await import("openai")).default as unknown as ReturnType<typeof vi.fn>;
    OpenAI.mockClear();

    createProviderInstance({
      providerId: "kimi-for-coding",
      apiKey: "sk-test",
      baseURL: "https://api.kimi.com/coding/v1",
      headers: { "User-Agent": "claude-cli/1.0 (external, cli)", "x-custom": "1" },
    });

    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({
      defaultHeaders: expect.objectContaining({
        "User-Agent": "claude-cli/1.0 (external, cli)",
        "x-custom": "1",
      }),
    }));
  });

  it("merges user headers over Ark defaults", async () => {
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInits.push(init ?? {});
      return makeSseResponse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "doubao",
      apiKey: "sk-test",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      headers: { "User-Agent": "my-approved-client" },
    });
    await collect(provider.streamChat([{ role: "user", content: "hi" }], { model: "doubao-seed" }));

    const headers = requestInits[0]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("my-approved-client");
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("merges user headers into Anthropic-protocol requests", async () => {
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInits.push(init ?? {});
      return new Response("bad request", { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderInstance } = await import("../provider.js");
    const provider = createProviderInstance({
      providerId: "kimi-for-coding",
      apiKey: "sk-test",
      baseURL: "https://api.kimi.com/coding",
      protocol: "anthropic-messages",
      headers: { "user-agent": "claude-cli/1.0 (external, cli)" },
    });
    await expect(
      collect(provider.streamChat([{ role: "user", content: "hi" }], { model: "kimi-k2.7-code" })),
    ).rejects.toThrow();

    const headers = requestInits[0]?.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe("claude-cli/1.0 (external, cli)");
    expect(headers["x-api-key"]).toBe("sk-test");
  });
});

describe("sanitizeProviderHeaders", () => {
  it("keeps string values, drops the rest, and returns undefined when empty", async () => {
    const { sanitizeProviderHeaders } = await import("../provider-registry.js");
    expect(sanitizeProviderHeaders({ "User-Agent": "x", bad: 42, worse: null })).toEqual({ "User-Agent": "x" });
    expect(sanitizeProviderHeaders({})).toBeUndefined();
    expect(sanitizeProviderHeaders("nope")).toBeUndefined();
    expect(sanitizeProviderHeaders(undefined)).toBeUndefined();
  });
});

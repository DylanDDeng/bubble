import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../agent.js";
import { getBuiltinProvider, listBuiltinModels } from "../model-catalog.js";
import { getModelPricing } from "../model-pricing.js";
import { buildAnthropicRequest } from "../provider-anthropic.js";
import { createProviderInstance } from "../provider.js";
import { ProviderRegistry } from "../provider-registry.js";
import { getDefaultThinkingLevel, isThinkingToggleModel } from "../provider-transform.js";
import type { AgentEvent, ToolRegistryEntry } from "../types.js";

const providerId = "mimo-token-plan";
const model = "mimo-v2.6-pro";
const options = { ...getBuiltinProvider(providerId)!, providerId, apiKey: "tp-fixture" };
const add: ToolRegistryEntry = {
  name: "add",
  description: "Add two numbers",
  readOnly: true,
  effect: "read",
  parameters: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  async execute({ a, b }) { return { content: String(a + b) }; },
};

function sse(content: object[], stopReason: string): Response {
  const events = [
    { type: "message_start", message: { id: "fixture", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    ...content.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Xiaomi MiMo Token Plan", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a key-only configuration to the plan endpoint and static chat catalog", async () => {
    const registry = new ProviderRegistry({ getProviders: () => [
      { id: providerId, apiKey: "tp-fixture", enabled: true },
    ] } as any);
    const profile = registry.getEnabled().find(p => p.id === providerId)!;
    expect(profile).toMatchObject({ baseURL: "https://token-plan-cn.xiaomimimo.com/anthropic", protocol: "anthropic-messages" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const catalog = await registry.discoverModels(profile);
    expect(catalog.source).toBe("static");
    expect(catalog.models.map(m => m.id)).toEqual(["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"]);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const entry of listBuiltinModels(providerId)) {
      expect(entry.contextWindow).toBe(1000000);
      expect(getDefaultThinkingLevel(providerId, entry.id)).toBe("medium");
      expect(isThinkingToggleModel(providerId, entry.id)).toBe(true);
      expect(getModelPricing(providerId, entry.id)).toBeUndefined();
    }
  });

  it.each(["off", "medium"] as const)("uses MiMo thinking=%s without Claude effort or cache fields", level => {
    const body = buildAnthropicRequest(options, [{ role: "system", content: "system" }, { role: "user", content: "hello" }], {
      model, tools: [add], thinkingLevel: level, temperature: 0.2, stream: true,
    });
    expect(body.thinking).toEqual({ type: level === "off" ? "disabled" : "enabled" });
    expect(body.max_tokens).toBe(131072);
    expect(body.output_config).toBeUndefined();
    expect(body.temperature).toBe(level === "off" ? 0.2 : undefined);
    expect(body.system).toBe("system");
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("defaults to thinking on and enforces toolChoice=none by omitting tools", () => {
    const body = buildAnthropicRequest(options, [{ role: "user", content: "hello" }], { model, tools: [add], toolChoice: "none" });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("recognizes custom MiMo endpoint profiles without matching lookalike hosts", () => {
    const custom = { ...options, providerId: "custom" };
    expect(buildAnthropicRequest(custom, [], { model }).thinking).toEqual({ type: "enabled" });
    expect(buildAnthropicRequest({ ...custom, baseURL: "https://token-plan-cn.xiaomimimo.com.example.org/anthropic" }, [], { model }).thinking).toBeUndefined();
  });

  it("completes non-streaming requests with the plan URL and bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "MIMO_OK" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProviderInstance(options);
    expect(await provider.complete([{ role: "user", content: "hello" }], { model, thinkingLevel: "off" })).toBe("MIMO_OK");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tp-fixture");
    expect(JSON.parse(init.body).thinking).toEqual({ type: "disabled" });
  });

  it("runs the Agent tool loop and replays signed thinking across user turns", async () => {
    const bodies: any[] = [];
    const thinking = { type: "thinking", thinking: "Use the add tool.", signature: "fixture-signature" };
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(url).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");
      const body = JSON.parse(init.body);
      bodies.push(body);
      expect(body.thinking).toEqual({ type: "enabled" });
      if (bodies.length === 1) return sse([
        thinking,
        { type: "tool_use", id: "add_1", name: "add", input: { a: 23, b: 19 } },
      ], "tool_use");
      return sse([{ type: "text", text: "42" }], "end_turn");
    }));
    const agent = new Agent({ provider: createProviderInstance(options), providerId, model, thinkingLevel: "medium", tools: [add], systemPrompt: "Use add to calculate." });
    const events: AgentEvent[] = [];
    for await (const event of agent.run("Add 23 and 19.", process.env.BUBBLE_HOME!)) events.push(event);
    expect(events.some(e => e.type === "tool_end" && e.name === "add" && e.result.content === "42")).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])).toContainEqual(thinking);
    expect(bodies[1].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])).toContainEqual({ type: "tool_result", tool_use_id: "add_1", content: "42" });
    for await (const event of agent.run("Repeat that result.", process.env.BUBBLE_HOME!)) events.push(event);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])).toContainEqual(thinking);
  });
});

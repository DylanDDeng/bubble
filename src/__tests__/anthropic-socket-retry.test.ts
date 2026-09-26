import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../agent.js";
import { createAnthropicMessagesProvider } from "../provider-anthropic.js";
import type { AgentEvent } from "../types.js";

// Exercise real Node fetch/SSE socket failures, not a mock with errno in its
// message: undici puts UND_ERR_SOCKET on the nested Error object's code.
describe("Anthropic socket interruption recovery", () => {
  let server: http.Server | undefined;
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "bubble-anthropic-retry-"));
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    vi.stubEnv("BUBBLE_SYSTEM_PROXY", "0");
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  function send(res: http.ServerResponse, event: object) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  async function fixture(mode: "recover" | "always-drop" | "wait") {
    const requests: unknown[] = [];
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      send(res, { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } });
      if (mode !== "recover" || requests.length === 1) {
        send(res, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
        send(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial reasoning" } });
        if (mode !== "wait") {
          const timer = setTimeout(() => res.destroy(), 30);
          res.on("close", () => clearTimeout(timer));
        }
      } else {
        send(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "complete answer" } });
        send(res, { type: "content_block_stop", index: 0 });
        send(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
        send(res, { type: "message_stop" });
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const provider = createAnthropicMessagesProvider({
      providerId: "anthropic", apiKey: "test-key",
      baseURL: `http://127.0.0.1:${address.port}`, thinkingLevel: "high",
    });
    return { requests, agent: new Agent({ provider, model: "claude-opus-5-5", tools: [] }) };
  }

  it("retries a real socket drop after thinking and commits only the completed response", async () => {
    const { agent, requests } = await fixture("recover");
    const events: AgentEvent[] = [];
    for await (const event of agent.run("hello", cwd)) events.push(event);
    expect(events.some((event) => event.type === "reasoning_delta")).toBe(true);
    expect(events.filter((event) => event.type === "provider_retry")).toEqual([
      expect.objectContaining({ attempt: 1, maxAttempts: 10 }),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    const messages = agent.messages.filter((message) => message.role === "assistant");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("complete answer");
    expect(JSON.stringify(messages)).not.toContain("partial reasoning");
  });

  it("stops after ten retries when every stream drops", async () => {
    const { agent, requests } = await fixture("always-drop");
    const events: AgentEvent[] = [];
    await expect((async () => {
      for await (const event of agent.run("hello", cwd)) events.push(event);
    })()).rejects.toMatchObject({ name: "ProviderStreamInterruptedError" });
    expect(requests).toHaveLength(11);
    expect(events.filter((event) => event.type === "provider_retry")).toHaveLength(10);
  });

  it("does not retry when the user cancels during thinking", async () => {
    const { agent, requests } = await fixture("wait");
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    await expect((async () => {
      for await (const event of agent.run("hello", cwd, { abortSignal: controller.signal })) {
        events.push(event);
        if (event.type === "reasoning_delta") controller.abort();
      }
    })()).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
    expect(events.filter((event) => event.type === "provider_retry")).toHaveLength(0);
  });
});

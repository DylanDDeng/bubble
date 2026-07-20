import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderInstance } from "../provider.js";
import { isProviderStreamInterruption } from "../network/retry.js";
import type { StreamChunk } from "../types.js";

/**
 * Regression: a socket drop while iterating an openai-chat SSE stream used to
 * propagate as a raw network error ("The socket connection was closed
 * unexpectedly"), which the agent loop does not retry — killing whole print
 * runs mid-task. The generic chat-completions path must wrap mid-stream
 * failures in ProviderStreamInterruptedError like the anthropic/codex/ai-sdk
 * paths do.
 */
describe("openai-chat stream interruption wrapping", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function startServer(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("no server address");
    return address.port;
  }

  function sse(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  it("wraps a mid-stream socket drop as ProviderStreamInterruptedError after surfacing partial content", async () => {
    const port = await startServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(sse({ choices: [{ delta: { content: "partial " } }] }));
      res.write(sse({ choices: [{ delta: { content: "answer" } }] }));
      // Drop the connection before finish_reason/[DONE]: simulates the
      // provider-side socket close seen on long benchmark runs.
      setTimeout(() => res.socket?.destroy(), 10);
    });

    const provider = createProviderInstance({
      providerId: "deepseek",
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
    });

    const received: StreamChunk[] = [];
    let caught: unknown;
    try {
      for await (const chunk of provider.streamChat([{ role: "user", content: "hi" }], { model: "deepseek-v4-pro" })) {
        received.push(chunk);
      }
    } catch (error) {
      caught = error;
    }

    expect(received.some((chunk) => chunk.type === "text")).toBe(true);
    expect(received.some((chunk) => chunk.type === "done")).toBe(false);
    expect(caught).toBeDefined();
    expect(isProviderStreamInterruption(caught)).toBe(true);
    expect((caught as Error).message).toContain("Provider stream interrupted");
  });

  it("completes normally when the stream finishes with [DONE]", async () => {
    const port = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "full answer" } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const provider = createProviderInstance({
      providerId: "deepseek",
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
    });

    const received: StreamChunk[] = [];
    for await (const chunk of provider.streamChat([{ role: "user", content: "hi" }], { model: "deepseek-v4-pro" })) {
      received.push(chunk);
    }

    expect(received.some((chunk) => chunk.type === "text")).toBe(true);
    expect(received.at(-1)?.type).toBe("done");
  });
});

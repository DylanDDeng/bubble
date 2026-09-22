import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../agent.js";
import { createOpenAICodexProvider } from "../provider-openai-codex.js";
import { getSessionsDir, SessionManager } from "../session.js";
import { BubbleSdk } from "../sdk/index.js";
import { AuthStorage } from "../oauth/storage.js";

const token = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
})).toString("base64url")}.sig`;
const event = (res: ServerResponse, data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
function finish(res: ServerResponse) {
  event(res, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } });
  res.end();
}
function disconnect(res: ServerResponse) {
  const timer = setTimeout(() => res.destroy(), 40);
  res.on("close", () => clearTimeout(timer));
}
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe("Codex real socket recovery", () => {
  let home: string;
  let server: Server | undefined;
  let requests: number;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bubble-socket-test-"));
    vi.stubEnv("BUBBLE_HOME", home);
    vi.stubEnv("BUBBLE_PROVIDER_MAX_RETRIES", "1");
    requests = 0;
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });
  async function provider(handler: (res: ServerResponse, request: number) => void) {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      handler(res, ++requests);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    return createOpenAICodexProvider({
      apiKey: token, baseURL: "https://fixture.invalid", providerId: "openai",
      fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, { signal: init?.signal }),
    });
  }
  function logs() {
    return readFileSync(join(home, "logs/provider-transport.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  }

  it("retries a closed response body before the first SSE event and logs the real cause", async () => {
    const transport = await provider((res, request) => {
      if (request === 1) { res.write(": connected\n\n"); disconnect(res); }
      else { event(res, { type: "response.output_text.delta", delta: "complete" }); finish(res); }
    });
    expect(await collect(transport.streamChat([{ role: "user", content: "private prompt" }], { model: "gpt-6-astra" })))
      .toContainEqual({ type: "text", content: "complete" });
    expect(requests).toBe(2);
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({
      attempt: 1, responseStatus: 200, receivedEvents: 0, decision: "retry",
      error: { code: "UND_ERR_SOCKET", message: "Provider connection failed." },
    });
    expect(JSON.stringify(logs())).not.toContain("private prompt");
    expect(JSON.stringify(logs())).not.toContain(token);
  });

  it("discards partial tool arguments, retries through Agent, executes once and persists the retry", async () => {
    const transport = await provider((res, request) => {
      if (request <= 2) {
        const callId = request === 1 ? "cut" : "complete";
        event(res, { type: "response.output_item.added", item: { type: "function_call", call_id: callId, name: "effect" } });
        event(res, { type: "response.function_call_arguments.delta", delta: request === 1 ? '{"value":' : '{"value":"ok"}' });
        if (request === 1) { disconnect(res); return; }
        event(res, { type: "response.function_call_arguments.done", arguments: '{"value":"ok"}' });
        event(res, { type: "response.output_item.done", item: { type: "function_call", call_id: callId } });
      } else event(res, { type: "response.output_text.delta", delta: "complete answer" });
      finish(res);
    });
    const file = join(home, "session.jsonl");
    const session = new SessionManager(file);
    const execute = vi.fn(async () => ({ content: "ok", status: "success" as const }));
    const agent = new Agent({ provider: transport, providerId: "openai", model: "gpt-6-astra",
      tools: [{ name: "effect", description: "test", parameters: { type: "object", properties: {} }, execute }],
      onProviderError: error => session.appendProviderError(error),
    });
    const events = await collect(agent.run("test", home));
    expect(requests).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.type === "provider_retry")).toHaveLength(1);
    expect(agent.messages.some(m => m.role === "assistant" && m.content === "complete answer")).toBe(true);
    expect(agent.messages.some(m => m.role === "assistant" && m.toolCalls?.some(t => t.id === "cut"))).toBe(false);
    expect(new SessionManager(file).getEntries()).toContainEqual(expect.objectContaining({
      type: "provider_error", error: expect.objectContaining({ code: "UND_ERR_SOCKET", retry: { attempt: 1, maxAttempts: 2 } }),
    }));
    expect(logs()[0]).toMatchObject({ decision: "delegate_retry", receivedEvents: 2, lastEventAgeMs: expect.any(Number) });
  });

  it("stops after two stream retries and keeps the terminal nested error code", async () => {
    const transport = await provider(res => {
      event(res, { type: "response.output_text.delta", delta: "partial" }); disconnect(res);
    });
    const session = new SessionManager(join(home, "session.jsonl"));
    const agent = new Agent({ provider: transport, model: "gpt-6-astra", tools: [],
      onProviderError: error => session.appendProviderError(error),
    });
    await expect(collect(agent.run("test", home))).rejects.toThrow("ChatGPT connection interrupted");
    expect(requests).toBe(3);
    const errors = session.getEntries().filter(e => e.type === "provider_error").map(e => e.error);
    expect(errors.map(e => e.retry?.attempt)).toEqual([1, 2, undefined]);
    expect(errors.every(e => e.code === "UND_ERR_SOCKET")).toBe(true);
  });

  it("honors the pre-stream retry cap", async () => {
    const transport = await provider(res => { res.write(": connected\n\n"); disconnect(res); });
    await expect(collect(transport.streamChat([{ role: "user", content: "test" }], { model: "gpt-6-astra" })))
      .rejects.toMatchObject({ message: "terminated", cause: { code: "UND_ERR_SOCKET" } });
    expect(requests).toBe(2);
    expect(logs().map(l => l.decision)).toEqual(["retry", "fail"]);
  });

  it("does not retry a user cancellation during streaming", async () => {
    const transport = await provider(res => event(res, { type: "response.output_text.delta", delta: "partial" }));
    const control = new AbortController();
    const consume = async () => {
      for await (const _chunk of transport.streamChat([{ role: "user", content: "test" }], {
        model: "gpt-6-astra", abortSignal: control.signal,
      })) control.abort();
    };
    await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(1);
    expect(logs()[0].decision).toBe("cancelled");
  });

  it("persists retry diagnostics through the desktop SDK entrypoint without changing replayed context", async () => {
    await provider((res, request) => {
      event(res, { type: "response.output_text.delta", delta: request === 1 ? "cut" : "complete answer" });
      if (request === 1) disconnect(res); else finish(res);
    });
    const nativeFetch = globalThis.fetch;
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("Unexpected request");
      return nativeFetch(`http://127.0.0.1:${address.port}`, { signal: init?.signal });
    });
    new AuthStorage(join(home, "auth.json")).set("openai", {
      type: "oauth", accessToken: token, refreshToken: "fixture", accountId: "fixture", expiresAt: Date.now() + 3_600_000,
    });
    const cwd = join(home, "project"); mkdirSync(cwd);
    const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
    const session = sdk.createSession({ cwd });
    const events = await collect(sdk.runTurn(session.id, { prompt: "hello", model: "openai:gpt-6-astra" }));
    expect(events.filter(e => e.type === "provider_retry")).toHaveLength(1);
    expect(requests).toBe(2);
    const saved = new SessionManager(join(getSessionsDir(cwd), `${session.id}.jsonl`));
    expect(saved.getEntries()).toContainEqual(expect.objectContaining({
      type: "provider_error", error: expect.objectContaining({ code: "UND_ERR_SOCKET", retry: { attempt: 1, maxAttempts: 2 } }),
    }));
    expect(sdk.getHistory(session.id).filter(m => m.role === "assistant").map(m => m.content)).toEqual(["complete answer"]);
    expect(logs()[0].error.code).toBe("UND_ERR_SOCKET");
  });
});

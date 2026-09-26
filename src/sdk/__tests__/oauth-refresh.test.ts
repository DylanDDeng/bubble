import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BubbleSdk, type AgentEvent } from "../index.js";
import { AuthStorage } from "../../oauth/storage.js";
import { OAUTH_REFRESH_TIMEOUT_MS } from "../../oauth/refresh-control.js";

// Exercise the public desktop entrypoint, actual Agent, provider, refresh HTTP
// implementation and disk locks. Only the external HTTP boundary is simulated.
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const model = "openai:gpt-6-astra";
const token = (tag: string) => `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, tag,
})).toString("base64url")}.sig`;
const credentials = (tag: string, expired = false) => ({
  type: "oauth" as const, accessToken: token(tag), refreshToken: `refresh-${tag}`,
  accountId: "test-account", expiresAt: Date.now() + (expired ? -60_000 : 3_600_000),
});
const refreshed = () => Response.json({ access_token: token("new"), refresh_token: "refresh-new", expires_in: 3600 });
const rejected = () => Response.json({ detail: { code: "token_expired" } }, { status: 401 });
function sse(events: object[] = [{ type: "response.output_text.delta", delta: "OK" }]) {
  return new Response([...events, { type: "response.completed", response: {
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("SDK main-session OAuth renewal", () => {
  let home: string;
  let cwd: string;
  let storage: AuthStorage;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bubble-sdk-oauth-"));
    cwd = join(home, "project"); mkdirSync(cwd);
    vi.stubEnv("BUBBLE_HOME", home);
    vi.stubEnv("BUBBLE_PROVIDER_MAX_RETRIES", "0");
    storage = new AuthStorage(join(home, "auth.json"));
    storage.set("openai", credentials("old", true));
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === TOKEN_URL) return refreshed();
      if (String(input).startsWith("https://chatgpt.com/backend-api/codex/responses")) return sse();
      throw new Error(`Unexpected HTTP destination: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  function sdk() { return new BubbleSdk({ defaultCwd: cwd, mcp: false }); }
  async function run(instance = sdk(), selectedModel = model, sessionId = instance.createSession({ cwd }).id) {
    const events: AgentEvent[] = [];
    for await (const event of instance.runTurn(sessionId, { prompt: "Say OK", model: selectedModel,
      onApproval: async () => ({ action: "approve" }) })) events.push(event);
    return { events, history: instance.getHistory(sessionId) };
  }
  const calls = (url: string) => fetchMock.mock.calls.filter(([input]) => String(input).startsWith(url));
  const requests = () => calls("https://chatgpt.com/backend-api/codex/responses");
  const bearer = (call: unknown[]) => new Headers((call[1] as RequestInit)?.headers).get("Authorization");

  it("refreshes expired credentials before the first main-agent request and persists the rotation", async () => {
    const { events, history } = await run();
    expect(calls(TOKEN_URL)).toHaveLength(1);
    expect(new URLSearchParams(String(calls(TOKEN_URL)[0][1].body)).get("refresh_token")).toBe("refresh-old");
    expect(requests().map(bearer)).toEqual([`Bearer ${token("new")}`]);
    expect(storage.get("openai")?.refreshToken).toBe("refresh-new");
    expect(events).toContainEqual({ type: "text_delta", content: "OK" });
    expect(history.some(m => m.role === "assistant" && m.content === "OK")).toBe(true);
  });

  it("keeps a valid login without unnecessary refresh", async () => {
    storage.set("openai", credentials("old"));
    await run();
    expect(calls(TOKEN_URL)).toHaveLength(0);
    expect(requests().map(bearer)).toEqual([`Bearer ${token("old")}`]);
  });

  it("also connects the existing Grok subscription renewal adapter", async () => {
    storage.remove("openai");
    storage.set("grok", credentials("old", true));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "https://auth.x.ai/oauth2/token") return refreshed();
      if (!String(input).startsWith("https://cli-chat-proxy.grok.com/")) throw new Error("Unexpected destination");
      return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { history } = await run(sdk(), "grok:grok-4.5");
    expect(calls("https://auth.x.ai/oauth2/token")).toHaveLength(1);
    expect(calls("https://cli-chat-proxy.grok.com/").map(bearer)).toEqual([`Bearer ${token("new")}`]);
    expect(storage.get("grok")?.refreshToken).toBe("refresh-new");
    expect(history.some(m => m.role === "assistant" && m.content === "OK")).toBe(true);
  });

  it.each([false, true])("retries token_expired only once (second rejection=%s)", async (rejectAgain) => {
    storage.set("openai", credentials("old"));
    let count = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === TOKEN_URL) return refreshed();
      return ++count === 1 || rejectAgain ? rejected() : sse();
    });
    if (rejectAgain) await expect(run()).rejects.toThrow(/401.*token_expired/s);
    else await run();
    expect(calls(TOKEN_URL)).toHaveLength(1);
    expect(requests().map(bearer)).toEqual([`Bearer ${token("old")}`, `Bearer ${token("new")}`]);
  });

  it("adopts another process's rotation after a rejected request", async () => {
    storage.set("openai", credentials("old"));
    fetchMock.mockImplementationOnce(async () => {
      new AuthStorage(join(home, "auth.json")).set("openai", credentials("rotated"));
      return rejected();
    });
    await run();
    expect(calls(TOKEN_URL)).toHaveLength(0);
    expect(requests().map(bearer)).toEqual([`Bearer ${token("old")}`, `Bearer ${token("rotated")}`]);
  });

  it("shares the refresh lock with another SDK/registry rather than reusing a refresh token", async () => {
    const first = sdk(), other = sdk();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetchMock.mockImplementationOnce(async () => { await gate; return refreshed(); });
    const preparing = other.registry.prepareProvider("openai");
    const turning = run(first);
    await vi.waitFor(() => expect(calls(TOKEN_URL)).toHaveLength(1));
    release();
    await Promise.all([preparing, turning]);
    expect(calls(TOKEN_URL)).toHaveLength(1);
    expect(requests().map(bearer)).toEqual([`Bearer ${token("new")}`]);
  });

  it("stops a main turn promptly while another session finishes the shared refresh", async () => {
    const first = sdk(), other = sdk();
    const session = first.createSession({ cwd });
    let release!: () => void;
    let refreshSignal: AbortSignal | null | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetchMock.mockImplementationOnce(async (_input, init?: RequestInit) => {
      refreshSignal = init?.signal;
      await gate;
      return refreshed();
    });
    const stopped = run(first, model, session.id).then(() => null, error => error as Error);
    let continued: ReturnType<typeof run> | undefined;
    try {
      await vi.waitFor(() => expect(calls(TOKEN_URL)).toHaveLength(1));
      continued = run(other);
      first.stop(session.id);
      await vi.waitFor(() => expect(first.getSessionRunState(session.id).active).toBe(false));
      expect((await stopped)?.message).toMatch(/stopped|abort|cancel/i);
      expect(refreshSignal).toBeDefined();
      expect(refreshSignal?.aborted).toBe(false);
      expect(existsSync(join(home, "auth.json.lock"))).toBe(true);
      release();
      await continued;
      expect(calls(TOKEN_URL)).toHaveLength(1);
      expect(requests().map(bearer)).toEqual([`Bearer ${token("new")}`]);
      expect(storage.get("openai")?.refreshToken).toBe("refresh-new");
      expect(existsSync(join(home, "auth.json.lock"))).toBe(false);
    } finally {
      release();
      await Promise.allSettled([stopped, ...(continued ? [continued] : [])]);
    }
  });

  it("times out a hung refresh, releases its disk lock, and ignores late credentials", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: (response: Response) => void;
    let refreshSignal: AbortSignal | null | undefined;
    const response = new Promise<Response>(resolve => { release = resolve; });
    fetchMock.mockImplementationOnce((_input, init?: RequestInit) => {
      refreshSignal = init?.signal;
      return response; // Deliberately ignores abort to test the deadline guard.
    });
    const failed = run().then(() => null, error => error as Error);
    try {
      await vi.waitFor(() => expect(calls(TOKEN_URL)).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_TIMEOUT_MS);
      expect((await failed)?.message).toMatch(/refresh timed out/i);
      expect((await failed)?.message).not.toMatch(/sign in again/i);
      expect(refreshSignal?.aborted).toBe(true);
      expect(existsSync(join(home, "auth.json.lock"))).toBe(false);
      expect(requests()).toHaveLength(0);
      release(Response.json({ access_token: token("late"), refresh_token: "refresh-late", expires_in: 3600 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(storage.get("openai")?.refreshToken).toBe("refresh-old");
      await run();
      expect(storage.get("openai")?.refreshToken).toBe("refresh-new");
    } finally {
      release(refreshed());
      vi.useRealTimers();
      await failed;
    }
  });

  it.each([401, 503])("surfaces refresh failure %s without sending the stale token or deleting the login", async (status) => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: status === 401 ? "invalid_grant" : "unavailable" } }, { status }));
    let failure: Error | undefined;
    try { await run(); } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain(`Token refresh failed: ${status}`);
    expect(failure?.message.includes("sign in again")).toBe(status === 401);
    expect(requests()).toHaveLength(0);
    expect(storage.get("openai")?.refreshToken).toBe("refresh-old");
  });

  it("refreshes between model calls in a real read-tool loop", async () => {
    storage.set("openai", credentials("old"));
    writeFileSync(join(cwd, "fixture.txt"), "SDK OAuth tool-loop proof");
    fetchMock.mockImplementationOnce(async () => {
      // Simulate the credential expiring while the Agent executes its tool.
      storage.set("openai", credentials("old", true));
      const item = { type: "function_call", call_id: "read-1", name: "read", arguments: "" };
      return sse([
        { type: "response.output_item.added", item },
        { type: "response.function_call_arguments.done", arguments: JSON.stringify({ path: "fixture.txt" }) },
        { type: "response.output_item.done", item },
      ]);
    });
    const { events, history } = await run();
    expect(calls(TOKEN_URL)).toHaveLength(1);
    expect(requests().map(bearer)).toEqual([`Bearer ${token("old")}`, `Bearer ${token("new")}`]);
    expect(events.some(e => e.type === "tool_end")).toBe(true);
    expect(history.some(m => m.role === "tool" && JSON.stringify(m).includes("SDK OAuth tool-loop proof"))).toBe(true);
  });
});

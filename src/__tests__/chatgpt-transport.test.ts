import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyChatGptNetworkError,
  createChatGptDispatcher,
  createChatGptFetch,
  getChatGptNetworkDiagnostics,
  getChatGptProxyForUrl,
  normalizeChatGptNetworkError,
} from "../network/chatgpt-transport.js";

describe("chatgpt transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not attach an undici dispatcher without proxy or custom CA env", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init as RequestInit & { dispatcher?: unknown })?.dispatcher).toBeUndefined();
      return new Response("ok");
    });
    const fetch = createChatGptFetch({ fetch: fetchMock, env: {} });

    await expect(fetch("https://chatgpt.com/backend-api/test")).resolves.toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attaches an undici dispatcher when proxy env is configured", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init as RequestInit & { dispatcher?: unknown })?.dispatcher).toBeTruthy();
      return new Response("ok");
    });
    const fetch = createChatGptFetch({
      fetch: fetchMock,
      env: {
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NO_PROXY: "localhost,127.0.0.1",
      },
    });

    await fetch("https://chatgpt.com/backend-api/test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not attach a proxy dispatcher when NO_PROXY matches the request host", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init as RequestInit & { dispatcher?: unknown })?.dispatcher).toBeUndefined();
      return new Response("ok");
    });
    const fetch = createChatGptFetch({
      fetch: fetchMock,
      env: {
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NO_PROXY: "chatgpt.com",
      },
    });

    await fetch("https://chatgpt.com/backend-api/test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates a dispatcher when custom CA env is configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-ca-"));
    try {
      const certPath = join(dir, "ca.pem");
      writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");

      expect(createChatGptDispatcher({ BUBBLE_EXTRA_CA_CERTS: certPath })).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid custom CA paths clearly", () => {
    expect(() => createChatGptDispatcher({ BUBBLE_EXTRA_CA_CERTS: "/missing/ca.pem" }))
      .toThrow(/Failed to read ChatGPT custom CA certificate/);
  });

  it("adds actionable guidance to certificate verification errors", () => {
    const error = normalizeChatGptNetworkError(
      new Error("unknown certificate verification error"),
      {},
    );

    expect(error.message).toContain("TLS certificate verification failed");
    expect(error.message).toContain("NODE_EXTRA_CA_CERTS");
    expect(error.message).toContain("HTTPS_PROXY");
    expect(error.message).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
  });

  it("classifies and reports redacted network diagnostics", () => {
    const diagnostics = getChatGptNetworkDiagnostics("https://chatgpt.com/backend-api/test", {
      HTTPS_PROXY: "http://user:pass@proxy.example.test:8080",
      ALL_PROXY: "socks://proxy.example.test:1080",
      NO_PROXY: "chatgpt.com",
      BUBBLE_EXTRA_CA_CERTS: "/very/secret/ca.pem",
    });

    expect(classifyChatGptNetworkError(new Error("unknown certificate verification error"))).toBe("tls_certificate");
    expect(diagnostics.endpointHost).toBe("chatgpt.com");
    expect(diagnostics.proxyEnv.https).toBe(true);
    expect(diagnostics.proxyEnv.all).toBe(true);
    expect(diagnostics.noProxyConfigured).toBe(true);
    expect(diagnostics.noProxyMatched).toBe(true);
    expect(diagnostics.extraCa.count).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain("user:pass");
    expect(JSON.stringify(diagnostics)).not.toContain("/very/secret/ca.pem");
  });

  it("resolves ALL_PROXY for ChatGPT requests when no scheme-specific proxy exists", () => {
    expect(getChatGptProxyForUrl("https://chatgpt.com/backend-api/test", {
      ALL_PROXY: "http://proxy.example.test:8080",
    })).toBe("http://proxy.example.test:8080");
  });

  it("preserves non-network errors unchanged", () => {
    const original = new Error("invalid request body");

    expect(normalizeChatGptNetworkError(original)).toBe(original);
  });
});

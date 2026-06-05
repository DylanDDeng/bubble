import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatGptDispatcher,
  createChatGptFetch,
  normalizeChatGptNetworkError,
  parseMacSystemProxyForUrl,
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
    const fetch = createChatGptFetch({ fetch: fetchMock, env: { BUBBLE_DISABLE_SYSTEM_PROXY: "1" } });

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

  it("parses the macOS HTTPS system proxy", () => {
    const output = `
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}
`;

    expect(parseMacSystemProxyForUrl(output, new URL("https://chatgpt.com/backend-api"))).toBe("http://127.0.0.1:7897");
  });

  it("respects macOS proxy exceptions", () => {
    const output = `
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : localhost
  }
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}
`;

    expect(parseMacSystemProxyForUrl(output, new URL("https://api.local/test"))).toBeUndefined();
    expect(parseMacSystemProxyForUrl(output, new URL("https://chatgpt.com/backend-api"))).toBe("http://127.0.0.1:7897");
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

  it("adds actionable guidance to Bun connection failures", () => {
    const error = normalizeChatGptNetworkError(
      new Error("Unable to connect. Is the computer able to access the url?"),
      {},
    );

    expect(error.message).toContain("ChatGPT connection failed before Bubble received a response");
    expect(error.message).toContain("proxy or network transport failure");
    expect(error.message).toContain("HTTPS_PROXY");
  });

  it("preserves non-network errors unchanged", () => {
    const original = new Error("invalid request body");

    expect(normalizeChatGptNetworkError(original)).toBe(original);
  });
});

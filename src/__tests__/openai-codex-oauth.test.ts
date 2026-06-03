import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeOpenAICodexAuthorizationInput,
  loginOpenAICodexDeviceCode,
  parseOpenAICodexAuthorizationInput,
} from "../oauth/openai-codex.js";

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function makeAccessToken(accountId: string): string {
  return `header.${encodePayload({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  })}.sig`;
}

describe("openai codex oauth", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses manual authorization inputs", () => {
    expect(parseOpenAICodexAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=state1"))
      .toEqual({ code: "abc", state: "state1" });
    expect(parseOpenAICodexAuthorizationInput("code=abc&state=state1"))
      .toEqual({ code: "abc", state: "state1" });
    expect(parseOpenAICodexAuthorizationInput("abc#state1"))
      .toEqual({ code: "abc", state: "state1" });
    expect(parseOpenAICodexAuthorizationInput("abc"))
      .toEqual({ code: "abc" });
  });

  it("exchanges a manual authorization code with its PKCE verifier", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("manual-code");
      expect(body.get("code_verifier")).toBe("verifier-123");
      expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
      return Response.json({
        access_token: makeAccessToken("account-123"),
        refresh_token: "refresh-123",
        expires_in: 3600,
      });
    });

    const tokens = await exchangeOpenAICodexAuthorizationInput(
      "http://localhost:1455/auth/callback?code=manual-code",
      "verifier-123",
      { fetch: fetchMock },
    );

    expect(tokens.refreshToken).toBe("refresh-123");
    expect(tokens.accountId).toBe("account-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes the OpenAI Codex device-code flow", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return Response.json({
          device_auth_id: "device-123",
          user_code: "USER-CODE",
          interval: 0,
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.device_auth_id).toBe("device-123");
        expect(body.user_code).toBe("USER-CODE");
        return Response.json({
          authorization_code: "auth-code-123",
          code_verifier: "device-verifier-123",
        });
      }
      if (url.endsWith("/oauth/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code")).toBe("auth-code-123");
        expect(body.get("code_verifier")).toBe("device-verifier-123");
        expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
        return Response.json({
          access_token: makeAccessToken("account-device"),
          refresh_token: "refresh-device",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const deviceCodes: string[] = [];

    const loginPromise = loginOpenAICodexDeviceCode({
      onDeviceCode: (info) => deviceCodes.push(`${info.verificationUri} ${info.userCode}`),
    }, { fetch: fetchMock });

    await vi.advanceTimersByTimeAsync(1_000);
    const tokens = await loginPromise;

    expect(deviceCodes).toEqual(["https://auth.openai.com/codex/device USER-CODE"]);
    expect(tokens.accountId).toBe("account-device");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

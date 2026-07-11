/**
 * xAI Grok subscription OAuth login (PKCE + local callback).
 *
 * Mirrors the public OAuth client used by the official Grok CLI so a Grok
 * subscription can drive Bubble's native agent loop the same way ChatGPT
 * OAuth does: browser sign-in once, then bearer + refresh tokens stored in
 * ~/.bubble/auth.json.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exec } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "./types.js";
import { chatGptFetch, type ChatGptFetch } from "../network/chatgpt-transport.js";

// Public OAuth client registered for the official Grok CLI ("Grok Build").
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const AUTH_URL = "https://auth.x.ai/oauth2/authorize";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

function generatePKCE() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function generateOpaqueId() {
  return globalThis.crypto?.randomUUID?.() ?? randomBytes(16).toString("hex");
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`, () => {
    // ignore errors; we show manual fallback in UI
  });
}

interface CallbackResult {
  code: string;
  state: string;
}

/**
 * xAI's OAuth client allows dynamic loopback ports, so listen on an ephemeral
 * port and report the redirect URI back to the login flow once bound.
 */
async function startCallbackServer(
  timeoutMs: number,
  onListening: (redirectUri: string) => void,
  onStatus?: (msg: string) => void,
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const server = createServer((req, res) => {
      try {
        const port = (server.address() as AddressInfo).port;
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const errorDesc = url.searchParams.get("error_description");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<html><body><h1>Authorization failed</h1><p>${errorDesc || error}</p></body></html>`);
            if (!resolved) {
              resolved = true;
              server.close(() => reject(new Error(`OAuth error: ${errorDesc || error}`)));
            }
            return;
          }

          if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Authorization successful</h1><p>You can close this window and return to the terminal.</p></body></html>");
            if (!resolved) {
              resolved = true;
              server.close(() => resolve({ code, state: state || "" }));
            }
            return;
          }
        }
        res.writeHead(404);
        res.end("Not found");
      } catch {
        res.writeHead(500);
        res.end("Error");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      onStatus?.(`Local server listening on http://127.0.0.1:${port}`);
      onListening(`http://127.0.0.1:${port}/callback`);
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close(() => reject(new Error(`OAuth login timed out after ${timeoutMs / 1000}s`)));
      }
    }, timeoutMs);
  });
}

export interface GrokLoginCallbacks {
  onStatus: (message: string) => void;
}

interface GrokTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function parseTokenResponse(data: GrokTokenResponse, fallbackRefreshToken?: string): OAuthTokens {
  if (!data.access_token || typeof data.access_token !== "string") {
    throw new Error("xAI returned no access token.");
  }
  const refreshToken = data.refresh_token || fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("xAI returned no refresh token.");
  }
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export async function loginGrok(
  callbacks?: GrokLoginCallbacks,
  options: { fetch?: ChatGptFetch } = {},
): Promise<OAuthTokens> {
  const fetchImpl = options.fetch ?? chatGptFetch;
  callbacks?.onStatus("Starting xAI Grok OAuth login...");

  const pkce = generatePKCE();
  const state = generateOpaqueId();
  const nonce = generateOpaqueId();

  let redirectUri = "";
  const serverPromise = startCallbackServer(5 * 60 * 1000, (uri) => {
    redirectUri = uri;
  }, callbacks?.onStatus);
  // The listen callback fires before any request can arrive; give the event
  // loop one tick so redirectUri is populated before building the URL.
  await new Promise((resolve) => setImmediate(resolve));
  if (!redirectUri) {
    throw new Error("The local OAuth callback server did not start.");
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
    referrer: "grok-build",
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;

  callbacks?.onStatus("Opening browser for authorization...");
  openBrowser(authUrl);
  callbacks?.onStatus(`If your browser didn't open, copy this URL manually:\n${authUrl}`);
  callbacks?.onStatus("Waiting for authorization (timeout: 5min)...");

  const { code, state: returnedState } = await serverPromise;
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch. Possible CSRF attack.");
  }

  callbacks?.onStatus("Exchanging authorization code for tokens...");
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const tokens = parseTokenResponse((await response.json()) as GrokTokenResponse);
  callbacks?.onStatus("Login successful!");
  return tokens;
}

export async function refreshGrok(
  refreshToken: string,
  options: { fetch?: ChatGptFetch } = {},
): Promise<OAuthTokens> {
  const fetchImpl = options.fetch ?? chatGptFetch;
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`Token refresh failed: ${response.status} ${response.statusText} - ${text}`);
  }

  return parseTokenResponse((await response.json()) as GrokTokenResponse, refreshToken);
}

/**
 * One-time credential import from the official Grok CLI's auth store (either
 * Bubble's isolated runtime profile or the user's real ~/.grok). Users who
 * already completed `grok login` skip the browser round-trip entirely.
 */
export function importGrokCliCredentials(bubbleHome = join(homedir(), ".bubble")): OAuthTokens | undefined {
  const candidates = [
    join(bubbleHome, "runtimes", "grok", "grok-home", "auth.json"),
    join(homedir(), ".grok", "auth.json"),
  ];
  for (const path of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.startsWith("https://auth.x.ai::")) continue;
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.key !== "string" || !entry.key || typeof entry.refresh_token !== "string" || !entry.refresh_token) {
        continue;
      }
      const expiresAt = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
      return {
        accessToken: entry.key,
        refreshToken: entry.refresh_token,
        // An unparseable expiry just means the first request refreshes.
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      };
    }
  }
  return undefined;
}

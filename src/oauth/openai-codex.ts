/**
 * OpenAI Codex OAuth login (PKCE + local callback).
 */

import { createServer } from "node:http";
import { exec } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import type { OAuthTokens } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";

function generatePKCE() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function generateState() {
  return randomBytes(16).toString("hex");
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

async function startCallbackServer(
  port: number,
  timeoutMs: number,
  onStatus?: (msg: string) => void
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        onStatus?.(`Received callback request: ${req.url}`);

        if (url.pathname === "/auth/callback") {
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
            res.end(`<html><body><h1>Authorization successful</h1><p>You can close this window and return to the terminal.</p></body></html>`);
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

    server.listen(port, "127.0.0.1", () => {
      onStatus?.(`Local server listening on http://127.0.0.1:${port}`);
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close(() => reject(new Error(`OAuth login timed out after ${timeoutMs / 1000}s`)));
      }
    }, timeoutMs);
  });
}

function parseJWT(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractAccountId(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const claims = parseJWT(idToken);
  const auth = claims?.["https://api.openai.com/auth"];
  return auth?.chatgpt_account_id || auth?.account_id || claims?.sub;
}

export interface OpenAICodexLoginCallbacks {
  onStatus: (message: string) => void;
}

export async function loginOpenAICodex(callbacks?: OpenAICodexLoginCallbacks): Promise<OAuthTokens> {
  callbacks?.onStatus("Starting OpenAI Codex OAuth login...");

  const pkce = generatePKCE();
  const state = generateState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });

  const authUrl = `${AUTH_URL}?${params.toString()}`;

  callbacks?.onStatus("Starting local callback server on port 1455...");
  const serverPromise = startCallbackServer(1455, 5 * 60 * 1000, callbacks?.onStatus);

  callbacks?.onStatus("Opening browser for authorization...");
  openBrowser(authUrl);
  callbacks?.onStatus(`If your browser didn't open, copy this URL manually:\n${authUrl}`);
  callbacks?.onStatus("Waiting for authorization (timeout: 5min)...");

  const { code, state: returnedState } = await serverPromise;
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch. Possible CSRF attack.");
  }

  callbacks?.onStatus("Exchanging authorization code for tokens...");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token?: string;
  };

  const expiresAt = Date.now() + data.expires_in * 1000;
  const accountId = extractAccountId(data.id_token);

  callbacks?.onStatus("Login successful!");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    idToken: data.id_token,
    accountId,
  };
}

export async function refreshOpenAICodex(refreshToken: string): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_URL, {
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

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };

  const expiresAt = Date.now() + data.expires_in * 1000;
  const accountId = extractAccountId(data.id_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
    idToken: data.id_token,
    accountId,
  };
}

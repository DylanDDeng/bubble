/**
 * OpenAI Codex OAuth login (PKCE + local callback/device code).
 */

import { createServer, type Server } from "node:http";
import { exec } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import type { OAuthTokens } from "./types.js";
import { chatGptFetch, type ChatGptFetch } from "../network/chatgpt-transport.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTH_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEFAULT_CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const SCOPE = "openid profile email offline_access";

export type OpenAICodexLoginMode = "browser" | "device" | "manual";

export interface OpenAICodexLoginCallbacks {
  onStatus?: (message: string) => void;
  onDeviceCode?: (info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  }) => void;
  onPrompt?: (prompt: { message: string }) => Promise<string>;
}

export interface OpenAICodexLoginOptions {
  fetch?: ChatGptFetch;
  mode?: OpenAICodexLoginMode;
  authorizationInput?: string;
  codeVerifier?: string;
  redirectUri?: string;
  callbackHost?: string;
  callbackBindHost?: string;
  callbackPort?: number;
  timeoutMs?: number;
  originator?: string;
  signal?: AbortSignal;
}

interface CallbackResult {
  code: string;
  state: string;
}

interface CallbackServerOptions {
  port: number;
  host: string;
  timeoutMs: number;
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
}

interface ResolvedCallbackOptions {
  redirectUri: string;
  redirectHost: string;
  bindHost: string;
  port: number;
  timeoutMs: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

interface DeviceAuthInfo {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

interface DeviceTokenSuccess {
  authorizationCode: string;
  codeVerifier: string;
}

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
    // Ignore errors; the URL is also shown in the UI.
  });
}

function resolveCallbackOptions(options: OpenAICodexLoginOptions = {}): ResolvedCallbackOptions {
  const redirectHost = (
    options.callbackHost
    ?? process.env.BUBBLE_OAUTH_CALLBACK_HOST
    ?? process.env.PI_OAUTH_CALLBACK_HOST
    ?? "localhost"
  ).trim();
  const bindHost = (
    options.callbackBindHost
    ?? process.env.BUBBLE_OAUTH_CALLBACK_BIND_HOST
    ?? process.env.PI_OAUTH_CALLBACK_BIND_HOST
    ?? redirectHost
  ).trim();
  const envPort = Number(process.env.BUBBLE_OAUTH_CALLBACK_PORT ?? process.env.PI_OAUTH_CALLBACK_PORT ?? "");
  const port = normalizePort(options.callbackPort ?? envPort, DEFAULT_CALLBACK_PORT);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
  return {
    redirectHost,
    bindHost,
    port,
    timeoutMs,
    redirectUri: options.redirectUri ?? `http://${formatHostForUrl(redirectHost)}:${port}${CALLBACK_PATH}`,
  };
}

function normalizePort(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function normalizeTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function buildAuthorizeUrl(input: {
  codeChallenge: string;
  state: string;
  redirectUri: string;
  originator?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  params.set("originator", input.originator || "bubble");
  return `${AUTH_URL}?${params.toString()}`;
}

export function parseOpenAICodexAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let server: Server | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: CallbackResult | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const complete = () => {
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      if (server?.listening) server.close(complete);
      else complete();
    };
    const onAbort = () => finish(toAbortError(options.signal));

    server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", `http://${formatHostForUrl(options.host)}:${options.port}`);
        options.onStatus?.(`Received callback request: ${req.url}`);

        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h1>Authorization failed</h1><p>${escapeHtml(errorDesc || error)}</p></body></html>`);
          finish(new Error(`OAuth error: ${errorDesc || error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h1>Authorization failed</h1><p>Missing authorization code.</p></body></html>");
          finish(new Error("OAuth callback did not include an authorization code."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>Authorization successful</h1><p>You can close this window and return to the terminal.</p></body></html>");
        finish({ code, state: state || "" });
      } catch (error) {
        res.writeHead(500);
        res.end("Error");
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    server.listen(options.port, options.host, () => {
      options.onStatus?.(`Local server listening on http://${formatHostForUrl(options.host)}:${options.port}`);
    });

    timeout = setTimeout(() => {
      finish(new Error(`OAuth login timed out after ${Math.round(options.timeoutMs / 1000)}s`));
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function extractAccountIdFromToken(token?: string): string | undefined {
  if (!token) return undefined;
  const claims = parseJWT(token);
  const auth = claims?.["https://api.openai.com/auth"];
  return auth?.chatgpt_account_id || auth?.account_id || claims?.sub;
}

function tokensFromResponse(data: TokenResponse, fallbackRefreshToken?: string): OAuthTokens {
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error(`Token response missing required fields: ${JSON.stringify(data)}`);
  }
  const refreshToken = data.refresh_token || fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error(`Token response missing refresh_token: ${JSON.stringify(data)}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    idToken: data.id_token,
    accountId: extractAccountIdFromToken(data.id_token) ?? extractAccountIdFromToken(data.access_token),
  };
}

async function readTokenResponse(response: Response, operation: string, fallbackRefreshToken?: string): Promise<OAuthTokens> {
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`Token ${operation} failed: ${response.status} ${response.statusText} - ${text}`);
  }
  const data = (await response.json()) as TokenResponse;
  return tokensFromResponse(data, fallbackRefreshToken);
}

async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl: ChatGptFetch;
  signal?: AbortSignal;
}): Promise<OAuthTokens> {
  const response = await input.fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: input.codeVerifier,
    }),
    signal: input.signal,
  });
  return readTokenResponse(response, "exchange");
}

export async function exchangeOpenAICodexAuthorizationInput(
  authorizationInput: string,
  codeVerifier: string,
  options: { fetch?: ChatGptFetch; redirectUri?: string; signal?: AbortSignal } = {},
): Promise<OAuthTokens> {
  const parsed = parseOpenAICodexAuthorizationInput(authorizationInput);
  if (!parsed.code) {
    throw new Error("Missing authorization code.");
  }
  return exchangeAuthorizationCode({
    code: parsed.code,
    codeVerifier,
    redirectUri: options.redirectUri ?? `http://localhost:${DEFAULT_CALLBACK_PORT}${CALLBACK_PATH}`,
    fetchImpl: options.fetch ?? chatGptFetch,
    signal: options.signal,
  });
}

async function startOpenAICodexDeviceAuth(fetchImpl: ChatGptFetch, signal?: AbortSignal): Promise<DeviceAuthInfo> {
  const response = await fetchImpl(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("OpenAI Codex device code login is not enabled for this server. Use browser login instead.");
    }
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex device code request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
  }

  const json = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: number | string;
  };
  const intervalSeconds = typeof json.interval === "string" ? Number(json.interval.trim()) : json.interval;
  if (!json.device_auth_id || !json.user_code || !Number.isFinite(intervalSeconds) || (intervalSeconds ?? 0) < 0) {
    throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds: intervalSeconds ?? 5,
  };
}

async function pollOpenAICodexDeviceAuth(input: {
  device: DeviceAuthInfo;
  fetchImpl: ChatGptFetch;
  callbacks?: OpenAICodexLoginCallbacks;
  signal?: AbortSignal;
}): Promise<DeviceTokenSuccess> {
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS;
  let intervalMs = Math.max(1, input.device.intervalSeconds) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs, input.signal);
    const response = await input.fetchImpl(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: input.device.deviceAuthId,
        user_code: input.device.userCode,
      }),
      signal: input.signal,
    });

    if (response.ok) {
      const json = (await response.json()) as { authorization_code?: string; code_verifier?: string };
      if (!json.authorization_code || !json.code_verifier) {
        throw new Error(`Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`);
      }
      return {
        authorizationCode: json.authorization_code,
        codeVerifier: json.code_verifier,
      };
    }

    if (response.status === 403 || response.status === 404) {
      input.callbacks?.onStatus?.("Waiting for device authorization...");
      continue;
    }

    const text = await response.text().catch(() => "");
    const errorCode = parseOAuthErrorCode(text);
    if (errorCode === "deviceauth_authorization_pending") {
      input.callbacks?.onStatus?.("Waiting for device authorization...");
      continue;
    }
    if (errorCode === "slow_down") {
      intervalMs += 5_000;
      continue;
    }

    throw new Error(`OpenAI Codex device auth failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
  }

  throw new Error("OpenAI Codex device code login timed out.");
}

function parseOAuthErrorCode(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as { error?: string | { code?: string } };
    return typeof json.error === "object" ? json.error.code : json.error;
  } catch {
    return undefined;
  }
}

export async function loginOpenAICodexDeviceCode(
  callbacks?: OpenAICodexLoginCallbacks,
  options: { fetch?: ChatGptFetch; signal?: AbortSignal } = {},
): Promise<OAuthTokens> {
  const fetchImpl = options.fetch ?? chatGptFetch;
  callbacks?.onStatus?.("Starting OpenAI Codex device code login...");
  const device = await startOpenAICodexDeviceAuth(fetchImpl, options.signal);
  callbacks?.onDeviceCode?.({
    userCode: device.userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_MS / 1000,
  });
  callbacks?.onStatus?.(`Open ${DEVICE_VERIFICATION_URI} and enter code: ${device.userCode}`);
  const code = await pollOpenAICodexDeviceAuth({ device, fetchImpl, callbacks, signal: options.signal });
  callbacks?.onStatus?.("Exchanging device authorization for tokens...");
  const tokens = await exchangeAuthorizationCode({
    code: code.authorizationCode,
    codeVerifier: code.codeVerifier,
    redirectUri: DEVICE_REDIRECT_URI,
    fetchImpl,
    signal: options.signal,
  });
  callbacks?.onStatus?.("Login successful!");
  return tokens;
}

export async function loginOpenAICodex(
  callbacks?: OpenAICodexLoginCallbacks,
  options: OpenAICodexLoginOptions = {},
): Promise<OAuthTokens> {
  const fetchImpl = options.fetch ?? chatGptFetch;
  const mode = options.mode ?? "browser";

  if (mode === "device") {
    return loginOpenAICodexDeviceCode(callbacks, { fetch: fetchImpl, signal: options.signal });
  }

  if (mode === "manual") {
    if (!options.authorizationInput || !options.codeVerifier) {
      throw new Error("Manual OpenAI Codex OAuth exchange requires both authorizationInput and codeVerifier.");
    }
    callbacks?.onStatus?.("Exchanging manually provided authorization code for tokens...");
    const tokens = await exchangeOpenAICodexAuthorizationInput(options.authorizationInput, options.codeVerifier, {
      fetch: fetchImpl,
      redirectUri: options.redirectUri,
      signal: options.signal,
    });
    callbacks?.onStatus?.("Login successful!");
    return tokens;
  }

  const callbackOptions = resolveCallbackOptions(options);
  callbacks?.onStatus?.("Starting OpenAI Codex OAuth login...");

  const pkce = generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizeUrl({
    codeChallenge: pkce.codeChallenge,
    state,
    redirectUri: callbackOptions.redirectUri,
    originator: options.originator,
  });

  callbacks?.onStatus?.(`Starting local callback server on ${callbackOptions.bindHost}:${callbackOptions.port}...`);
  const serverAbort = new AbortController();
  const forwardAbort = () => serverAbort.abort(toAbortError(options.signal));
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const serverPromise = startCallbackServer({
    port: callbackOptions.port,
    host: callbackOptions.bindHost,
    timeoutMs: callbackOptions.timeoutMs,
    onStatus: callbacks?.onStatus,
    signal: serverAbort.signal,
  });

  callbacks?.onStatus?.("Opening browser for authorization...");
  openBrowser(authUrl);
  callbacks?.onStatus?.(`If your browser did not open, copy this URL manually:\n${authUrl}`);
  callbacks?.onStatus?.(`Waiting for authorization (timeout: ${Math.round(callbackOptions.timeoutMs / 1000)}s)...`);

  const promptPromise = callbacks?.onPrompt?.({ message: "Paste the authorization code or full redirect URL:" })
    .then((input) => ({ manualInput: input }))
    .catch((error) => ({ promptError: error }));
  const callbackPromise = serverPromise
    .then((result) => ({ callback: result }))
    .catch((error) => ({ callbackError: error }));
  const result = promptPromise
    ? await Promise.race([callbackPromise, promptPromise])
    : await callbackPromise;
  options.signal?.removeEventListener("abort", forwardAbort);

  if ("promptError" in result && result.promptError) {
    serverAbort.abort(new Error("Manual authorization prompt failed."));
    throw result.promptError;
  }
  if ("callbackError" in result && result.callbackError) {
    throw result.callbackError;
  }

  const parsed = "manualInput" in result
    ? parseOpenAICodexAuthorizationInput(result.manualInput)
    : "callback" in result
      ? result.callback
      : {};
  if ("manualInput" in result) {
    serverAbort.abort(new Error("Manual authorization input received."));
  }
  if (!parsed.code) {
    throw new Error("Missing authorization code.");
  }
  if (parsed.state !== state) {
    throw new Error("OAuth state mismatch. Possible CSRF attack.");
  }

  callbacks?.onStatus?.("Exchanging authorization code for tokens...");
  const tokens = await exchangeAuthorizationCode({
    code: parsed.code,
    codeVerifier: pkce.codeVerifier,
    redirectUri: callbackOptions.redirectUri,
    fetchImpl,
    signal: options.signal,
  });
  callbacks?.onStatus?.("Login successful!");
  return tokens;
}

export async function refreshOpenAICodex(
  refreshToken: string,
  options: { fetch?: ChatGptFetch; signal?: AbortSignal } = {},
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
    signal: options.signal,
  });
  return readTokenResponse(response, "refresh", refreshToken);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(toAbortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(toAbortError(signal));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException(typeof signal?.reason === "string" ? signal.reason : "Login cancelled", "AbortError");
}

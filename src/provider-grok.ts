/**
 * Grok subscription provider support.
 *
 * The CLI chat proxy (cli-chat-proxy.grok.com) speaks the OpenAI
 * chat-completions protocol, so the generic OpenAI provider does the heavy
 * lifting. This module supplies the two Grok-specific pieces: the client
 * identity headers the proxy gates on, and a fetch wrapper that keeps the
 * OAuth bearer fresh across long sessions.
 */

import type { OAuthCredentials } from "./oauth/types.js";
import { getChatGptFetch, type ChatGptFetch } from "./network/chatgpt-transport.js";

export const GROK_SUBSCRIPTION_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
// The proxy rejects requests below a minimum client version; identify as the
// same pinned CLI build Bubble verifies elsewhere.
export const GROK_CLIENT_VERSION = "0.2.93";
const TOKEN_REFRESH_GRACE_MS = 5 * 60 * 1000;

export function isGrokSubscriptionBaseUrl(baseURL: string): boolean {
  const normalized = baseURL.trim().replace(/\/+$/, "");
  return normalized === GROK_SUBSCRIPTION_BASE_URL || normalized.startsWith(`${GROK_SUBSCRIPTION_BASE_URL}/`);
}

export function buildGrokSubscriptionHeaders(): Record<string, string> {
  return {
    "User-Agent": "grok-cli",
    "x-grok-client-version": GROK_CLIENT_VERSION,
  };
}

export interface GrokAuthAdapter {
  getCredentials: () => OAuthCredentials | undefined | Promise<OAuthCredentials | undefined>;
  refreshCredentials: (current?: OAuthCredentials) => Promise<OAuthCredentials>;
  isExpired?: (credentials: OAuthCredentials, graceMs: number) => boolean;
}

/**
 * Wrap a fetch so every request carries a fresh subscription bearer. The
 * OpenAI client's static apiKey would go stale after ~6h; this reads (and
 * proactively refreshes) the stored OAuth credentials per request instead.
 */
export function createGrokSubscriptionFetch(
  auth: GrokAuthAdapter,
  baseFetch: ChatGptFetch = getChatGptFetch(),
): ChatGptFetch {
  let refreshPromise: Promise<OAuthCredentials> | undefined;

  async function freshAccessToken(): Promise<string | undefined> {
    let credentials = await auth.getCredentials();
    if (!credentials) return undefined;
    const expired = auth.isExpired
      ? auth.isExpired(credentials, TOKEN_REFRESH_GRACE_MS)
      : Date.now() >= credentials.expiresAt - TOKEN_REFRESH_GRACE_MS;
    if ((expired || !credentials.accessToken) && credentials.refreshToken) {
      if (!refreshPromise) {
        refreshPromise = auth.refreshCredentials(credentials).finally(() => {
          refreshPromise = undefined;
        });
      }
      credentials = await refreshPromise;
    }
    return credentials.accessToken || undefined;
  }

  return async (input, init) => {
    const token = await freshAccessToken();
    if (!token) {
      return baseFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return baseFetch(input, { ...(init ?? {}), headers });
  };
}

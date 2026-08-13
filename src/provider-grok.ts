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
import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

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

export interface GrokModelDescriptor {
  id: string;
  name?: string;
  /** Server-declared context window (the /models `context_window` field). */
  contextWindow?: number;
  /** Server-declared reasoning effort ladder, sorted ascending. */
  reasoningEfforts?: ThinkingLevel[];
  /** Server-declared default effort (the /models `reasoning_effort` field). */
  defaultReasoningEffort?: ThinkingLevel;
}

/**
 * Fetch the model list for a Grok subscription account. The CLI chat proxy
 * gates on the grok-cli identity headers plus a fresh OAuth bearer, so this
 * rides the same refreshing fetch used for chat requests instead of a raw
 * global fetch. The /models payload carries richer metadata than id+name —
 * `context_window`, `reasoning_efforts`, and the default `reasoning_effort` —
 * which this surfaces so discovery can stop inferring them. Throws on a
 * non-2xx so callers fall back to the curated catalog.
 */
export async function fetchGrokSubscriptionModels(
  baseURL: string,
  auth: GrokAuthAdapter,
  options: { timeoutMs?: number; fetch?: ChatGptFetch } = {},
): Promise<GrokModelDescriptor[]> {
  const fetchImpl = createGrokSubscriptionFetch(auth, options.fetch);
  const base = baseURL.trim().replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/models`, {
    headers: buildGrokSubscriptionHeaders(),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: Array<Record<string, unknown>>;
    models?: Array<Record<string, unknown>>;
  };
  const entries = payload.data ?? payload.models ?? [];
  return entries
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry?.id === "string" && entry.id.trim().length > 0)
    .map((entry) => {
      const id = entry.id as string;
      const rawEfforts = Array.isArray(entry.reasoning_efforts) ? entry.reasoning_efforts : [];
      const reasoningEfforts = rawEfforts
        .map((effort) => (
          effort && typeof effort === "object" && typeof (effort as Record<string, unknown>).value === "string"
            ? (effort as Record<string, unknown>).value as string
            : undefined
        ))
        .filter((value): value is ThinkingLevel =>
          typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value))
        .sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));
      const defaultReasoningEffort = typeof entry.reasoning_effort === "string"
        && (THINKING_LEVELS as readonly string[]).includes(entry.reasoning_effort)
        ? entry.reasoning_effort as ThinkingLevel
        : undefined;
      return {
        id,
        name: typeof entry.name === "string" ? entry.name : undefined,
        contextWindow: typeof entry.context_window === "number" && entry.context_window > 0
          ? entry.context_window
          : undefined,
        reasoningEfforts: reasoningEfforts.length > 0 ? reasoningEfforts : undefined,
        defaultReasoningEffort,
      };
    });
}

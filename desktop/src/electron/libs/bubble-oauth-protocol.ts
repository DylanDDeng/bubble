export type BubbleOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
  accountId?: string;
};

export function authorizationUrlFromStatus(providerId: string, message: string): string | undefined {
  const candidate = message.match(/https:\/\/[^\s]+/u)?.[0];
  if (!candidate) return;
  try {
    const url = new URL(candidate);
    const expected = providerId === 'openai'
      ? 'https://auth.openai.com/oauth/authorize'
      : providerId === 'grok' ? 'https://auth.x.ai/oauth2/authorize' : '';
    if (`${url.origin}${url.pathname}` === expected && !url.username && !url.password) return url.href;
  } catch { /* not an authorization URL */ }
}

export function validOAuthTokens(value: unknown): value is BubbleOAuthTokens {
  if (!value || typeof value !== 'object') return false;
  const tokens = value as BubbleOAuthTokens;
  return typeof tokens.accessToken === 'string' && !!tokens.accessToken.trim()
    && typeof tokens.refreshToken === 'string' && !!tokens.refreshToken.trim()
    && Number.isFinite(tokens.expiresAt) && tokens.expiresAt > Date.now()
    && (tokens.idToken === undefined || typeof tokens.idToken === 'string')
    && (tokens.accountId === undefined || typeof tokens.accountId === 'string');
}

/** Only allowlisted diagnostics cross IPC: never response bodies, URLs or codes/tokens. */
export function safeOAuthError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      messages.push(current.message);
      const code = (current as NodeJS.ErrnoException).code;
      if (code) messages.push(code);
      current = current.cause;
    } else { break; }
  }
  const message = messages.join('\n');
  if (/already in use|EADDRINUSE/i.test(message)) return 'The sign-in callback port is in use. Close the other sign-in attempt and retry.';
  if (/state mismatch/i.test(message)) return 'The sign-in response did not match this attempt. Start a new sign-in and use its browser tab.';
  if (/access_denied|OAuth error/i.test(message) && !/Token exchange failed:/i.test(message)) return 'Authorization was declined or could not be completed. Please try again.';
  const exchangeStatus = message.match(/Token exchange failed:\s*(\d{3})\b/i)?.[1];
  if (exchangeStatus) {
    const reason = /["']invalid_grant["']/i.test(message)
      ? 'The authorization code expired, was already used, or was rejected. Start a new sign-in.'
      : /["']invalid_client["']/i.test(message)
        ? 'The provider rejected the OAuth client. The login integration needs to be checked.'
        : /["']unsupported_country_region_territory["']/i.test(message)
          ? 'The provider does not support the current network region.'
          : exchangeStatus === '429'
            ? 'The provider is rate limiting sign-ins. Wait a moment before trying again.'
            : exchangeStatus.startsWith('5')
              ? 'The provider could not complete the request. Please try again later.'
              : 'The provider rejected the token request. Start a new sign-in; if it repeats, report this HTTP status.';
    return `Token exchange failed (HTTP ${exchangeStatus}). ${reason}`;
  }
  if (/certificate|unable to verify|self[- ]signed|CERT_/i.test(message)) return 'Token exchange could not verify the TLS certificate. Check the proxy or custom CA configuration.';
  const networkCode = message.match(/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)\b/)?.[1];
  if (networkCode) return `Token exchange could not connect (${networkCode}). Check the desktop app’s proxy/network and start a new sign-in.`;
  if (/timed out|timeout/i.test(message)) return 'Sign-in timed out. Please try again.';
  if (/fetch failed|connection failed before|network.*failed/i.test(message)) return 'Token exchange could not reach the provider. Check the desktop app’s proxy/network and start a new sign-in.';
  if (/no access token|no refresh token/i.test(message)) return 'The provider returned incomplete credentials. Please start a new sign-in.';
  return 'The sign-in process failed unexpectedly. Start a new sign-in; if it repeats, report which step failed.';
}

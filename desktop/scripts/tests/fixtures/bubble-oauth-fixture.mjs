// Native integration fixture: real SDK PKCE and loopback callbacks, with only
// the browser launch and remote token exchange substituted. Never opens a tab.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
cp.exec = () => ({});
syncBuiltinESMExports();
const real = await import(process.env.BUBBLE_TEST_REAL_OAUTH);
const mode = process.env.BUBBLE_TEST_OAUTH_MODE || 'success';
const fixtureId = 'fixture-access-token-never-render';
async function login(provider, callbacks) {
  let challenge;
  return real[provider === 'openai' ? 'loginOpenAICodex' : 'loginGrok']({
    onStatus(message) {
      callbacks.onStatus(message);
      const text = message.match(/https:\/\/auth\.[^\s]+/)?.[0];
      if (!text) return;
      const url = new URL(text);
      challenge = url.searchParams.get('code_challenge');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.hostname = '127.0.0.1';
      writeFileSync(join(process.env.BUBBLE_HOME, 'callback-fixture.json'), JSON.stringify({ port: Number(redirect.port) }));
      if (mode === 'pending') return;
      redirect.searchParams.set('state', mode === 'bad-state' ? 'wrong' : url.searchParams.get('state'));
      if (mode === 'denied') redirect.searchParams.set('error', 'access_denied');
      else redirect.searchParams.set('code', 'fixture-code-never-render');
      setTimeout(() => { void fetch(redirect).catch(() => {}); }, 50);
    },
  }, {
    fetch: async (_url, options) => {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('code'), 'fixture-code-never-render');
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
      if (mode === 'exchange-error') return new Response('SECRET-provider-error-body', { status: 401 });
      if (mode === 'expired-code') return Response.json({ error: 'invalid_grant', detail: 'SECRET-provider-error-body' }, { status: 400 });
      if (mode === 'network-error') throw new TypeError('fetch failed', { cause: Object.assign(new Error('SECRET-proxy-address'), { code: 'ECONNREFUSED' }) });
      return Response.json({ access_token: fixtureId, refresh_token: 'fixture-refresh', expires_in: 3600 });
    },
  });
}
export const loginOpenAICodex = callbacks => login('openai', callbacks);
export const loginGrok = callbacks => login('grok', callbacks);

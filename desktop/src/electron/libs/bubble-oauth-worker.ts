// OAuth's loopback server lives in a disposable process: cancellation/quit
// closes the listener and any in-flight exchange without changing the SDK flow.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeOAuthError, authorizationUrlFromStatus } from './bubble-oauth-protocol';

const parent = (process as unknown as { parentPort: { postMessage(value: unknown): void } }).parentPort;
const [runtimeRoot, providerId] = process.argv.slice(2);
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

void (async () => {
  try {
    if (providerId !== 'openai' && providerId !== 'grok') throw new Error('Unsupported provider');
    const oauth = await importEsm(pathToFileURL(join(runtimeRoot, 'runtime/bubble/dist/oauth/index.js')).href);
    const login = providerId === 'openai' ? oauth.loginOpenAICodex : oauth.loginGrok;
    const tokens = await login({ onStatus(message: string) {
      // SDK statuses can contain the callback authorization code. Forward only
      // the allowlisted authorization URL, never arbitrary status/error text.
      if (message === 'Exchanging authorization code for tokens...') parent.postMessage({ type: 'exchanging' });
      const url = authorizationUrlFromStatus(providerId, message);
      if (url) parent.postMessage({ type: 'authorization-url', url });
    } });
    parent.postMessage({ type: 'success', tokens });
  } catch (error) {
    parent.postMessage({ type: 'error', error: safeOAuthError(error) });
  }
})();

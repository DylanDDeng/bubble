const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const net = require('node:net');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bubble-oauth-qa-'));
app.setPath('userData', path.join(temp, 'desktop'));
process.env.BUBBLE_HOME = path.join(temp, 'agent');
fs.mkdirSync(app.getPath('userData'), { recursive: true });
fs.mkdirSync(process.env.BUBBLE_HOME);
const fixtureApp = path.join(temp, 'app');
const fixtureDist = path.join(fixtureApp, 'runtime/bubble/dist');
fs.mkdirSync(path.join(fixtureDist, 'oauth'), { recursive: true });
fs.mkdirSync(path.join(fixtureDist, 'sdk'), { recursive: true });
fs.writeFileSync(path.join(fixtureApp, 'package.json'), '{"type":"module"}');
for (const file of ['sdk/index.js', 'provider-registry.js']) {
  fs.writeFileSync(path.join(fixtureDist, file), `export * from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/bubble/dist', file)).href)};`);
}
fs.copyFileSync(path.join(__dirname, 'fixtures/bubble-oauth-fixture.mjs'), path.join(fixtureDist, 'oauth/index.js'));
process.env.BUBBLE_TEST_REAL_OAUTH = pathToFileURL(path.join(root, 'runtime/bubble/dist/oauth/index.js')).href;
app.setAppPath(fixtureApp);
const oauth = require('../../dist-electron/electron/libs/bubble-oauth.js');
const settings = require('../../dist-electron/electron/libs/bubble-settings.js');
const { getBubbleSdk } = require('../../dist-electron/electron/libs/provider/bubble-sdk-loader.js');
const { authorizationUrlFromStatus, safeOAuthError } = require('../../dist-electron/electron/libs/bubble-oauth-protocol.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}
const row = async id => (await settings.getBubbleProvidersConfig()).providers.find(p => p.id === id);
const deadline = setTimeout(() => { oauth.cancelBubbleOAuth(); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  assert.equal((await row('openai')).supportsOAuth, true);
  assert.equal((await row('grok')).oauthOnly, true);
  await assert.rejects(settings.setBubbleProviderKey('grok', 'fake'), /requires browser/);
  assert.equal(authorizationUrlFromStatus('openai', 'Received callback request: http://localhost:1455/auth/callback?code=secret'), undefined);
  assert.equal(authorizationUrlFromStatus('openai', 'https://auth.openai.com.evil.example/oauth/authorize'), undefined);
  assert(!safeOAuthError(new Error('Token exchange failed: SECRET')).includes('SECRET'));
  // Seed a matching API catalog, then verify OAuth cannot reuse it.
  await settings.setBubbleProviderKey('openai', 'fixture-api-key');
  const apiProfile = (await getBubbleSdk()).registry.getConfigured().find(p => p.id === 'openai');
  const identity = require('node:crypto').createHash('sha256').update(JSON.stringify([apiProfile.authType || 'api', apiProfile.baseURL, apiProfile.apiKey])).digest('hex');
  fs.writeFileSync(path.join(app.getPath('userData'), 'bubble-model-catalog-cache.json'), JSON.stringify({
    providers: { openai: [{ id: 'api-only-fixture-model' }] }, identities: { openai: identity },
  }));
  assert((await settings.getBubbleModelConfig()).options.includes('openai:api-only-fixture-model'));
  for (const provider of ['openai', 'grok']) {
    process.env.BUBBLE_TEST_OAUTH_MODE = 'success';
    let notified = false;
    assert.equal(oauth.startBubbleOAuth(provider, 1, () => { notified = true; }).status, 'pending');
    assert.throws(() => oauth.startBubbleOAuth(provider, 1), /already in progress/);
    await until(() => oauth.getBubbleOAuthState().status !== 'pending', `${provider} login`);
    assert.equal(oauth.getBubbleOAuthState().status, 'success', JSON.stringify(oauth.getBubbleOAuthState()));
    assert.equal(notified, true, 'model picker notified even without settings mounted');
    assert.equal((await row(provider)).authType, 'oauth');
    assert.equal((await row(provider)).hasApiKey, false);
    if (provider === 'openai') assert(!(await settings.getBubbleModelConfig()).options.includes('openai:api-only-fixture-model'));
    assert.equal(await settings.getBubbleProviderKey(provider), '', 'OAuth token never exposed as API key');
    assert(!JSON.stringify(await settings.getBubbleProvidersConfig()).includes('fixture-access'));
    const auth = JSON.parse(fs.readFileSync(path.join(process.env.BUBBLE_HOME, 'auth.json'), 'utf8'));
    assert(JSON.stringify(auth).includes('fixture-access-token-never-render'));
    await settings.setBubbleProviderEnabled(provider, false);
    assert.equal((await row(provider)).enabled, false);
    assert(!fs.readFileSync(path.join(process.env.BUBBLE_HOME, 'config.json'), 'utf8').includes('fixture-access'));
    await settings.setBubbleProviderEnabled(provider, true);
    await settings.setBubbleDefaultProvider(provider);
    assert.equal((await row(provider)).isDefault, true);
    if (provider === 'openai') {
      await assert.rejects(settings.setBubbleProviderKey(provider, 'api-key'), /Sign out/);
      const sdk = await getBubbleSdk();
      sdk.registry.getAuthStorage().set('openai-codex', { type: 'oauth', accessToken: 'legacy-fixture', refreshToken: 'legacy-refresh', expiresAt: Date.now() + 3600000 });
    }
    await settings.logoutBubbleOAuth(provider);
    assert.equal((await row(provider)).authType, provider === 'openai' ? 'api' : 'none');
    assert.deepEqual((await getBubbleSdk()).registry.getOAuthLoginKeys(provider), []);
  }
  // API and subscription are distinct; switching to OAuth never erases the saved API key.
  await settings.setBubbleProviderKey('openai', 'fixture-api-key');
  assert.equal((await row('openai')).authType, 'api');
  assert.equal(await settings.getBubbleProviderKey('openai'), 'fixture-api-key');
  for (const mode of ['denied', 'bad-state', 'exchange-error', 'expired-code', 'network-error']) {
    process.env.BUBBLE_TEST_OAUTH_MODE = mode;
    oauth.startBubbleOAuth('grok', 1);
    await until(() => oauth.getBubbleOAuthState().status === 'error', mode);
    assert(!JSON.stringify(oauth.getBubbleOAuthState()).includes('SECRET'));
    const failure = oauth.getBubbleOAuthState();
    if (['exchange-error', 'expired-code', 'network-error'].includes(mode)) {
      assert.equal(failure.phase, 'exchanging');
      assert.equal(failure.canReopen, false, 'consumed authorization URL must not be reopened');
    }
    if (mode === 'exchange-error') assert.match(failure.error, /HTTP 401/);
    if (mode === 'expired-code') assert.match(failure.error, /HTTP 400.*expired/);
    if (mode === 'network-error') assert.match(failure.error, /ECONNREFUSED/);
    assert.equal((await row('grok')).authType, 'none');
  }
  process.env.BUBBLE_TEST_OAUTH_MODE = 'pending';
  oauth.startBubbleOAuth('grok', 1);
  await until(() => oauth.getBubbleOAuthState().canReopen, 'callback listener');
  const { port } = JSON.parse(fs.readFileSync(path.join(process.env.BUBBLE_HOME, 'callback-fixture.json')));
  assert(await canConnect(port));
  oauth.cancelBubbleOAuth(2);
  assert.equal(oauth.getBubbleOAuthState().status, 'pending', 'unrelated window cannot cancel via destruction');
  oauth.cancelBubbleOAuth(1);
  await until(async () => !(await canConnect(port)), 'cancel closes callback socket');
  assert.equal(oauth.getBubbleOAuthState().status, 'idle');
  assert.equal((await row('grok')).authType, 'none');
  process.env.BUBBLE_TEST_OAUTH_MODE = 'success';
  oauth.startBubbleOAuth('grok', 1);
  await until(() => oauth.getBubbleOAuthState().status === 'success', 'retry after cancellation');
  await settings.removeBubbleProvider('grok');
  assert.equal((await row('grok')).configured, false, 'removed OAuth provider cannot auto-reappear');
  console.log('PASS: real SDK PKCE/callbacks for ChatGPT and Grok, isolated persistence, token redaction, logout aliases, enable/default, cancellation closes listener, retry, removal and safe errors');
}).then(() => finish(0)).catch(error => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(deadline);
  oauth.cancelBubbleOAuth();
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(code);
}

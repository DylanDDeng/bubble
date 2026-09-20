const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-catalog-integration-'));
app.setPath('userData', path.join(home, 'desktop'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
process.env.BUBBLE_HOME = path.join(home, 'agent');
let response = { status: 200, body: { data: [{ id: 'gpt-catalog-fixture' }] } };
const server = http.createServer((req, res) => {
  assert.equal(req.url, '/v1/models');
  res.writeHead(response.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response.body));
});

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { ProviderRegistry } = await import(pathToFileURL(path.resolve(__dirname, '../../runtime/bubble/dist/provider-registry.js')).href);
  let profile = { id: 'openai', authType: 'api', apiKey: 'fixture-account-a', baseURL: `http://127.0.0.1:${server.address().port}/v1`, enabled: true };
  const makeRegistry = () => {
    const registry = new ProviderRegistry({ getProviders: () => [profile] });
    registry.getConfigured = registry.getEnabled = () => [profile];
    return registry;
  };
  let created = 0;
  const sentModels = [];
  const sdk = {
    registry: makeRegistry(),
    getModelConfig: () => ({ defaultModel: 'openai:gpt-5.1', providers: [{ id: 'openai', hasApiKey: true }] }),
    createSession: () => ({ id: `fixture-${++created}` }),
    deleteSession: () => {},
    async *runTurn(id, options) { sentModels.push(options.model); yield { type: 'agent_end' }; },
  };
  const loader = require('../../dist-electron/electron/libs/provider/bubble-sdk-loader.js');
  loader.getBubbleSdk = async () => sdk;
  loader.reloadBubbleSdkConfig = () => {};
  const settings = require('../../dist-electron/electron/libs/bubble-settings.js');
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');
  const adapter = new BubbleSdkAdapter();
  const start = (model) => adapter.startSession({ threadId: 'fixture', cwd: home, prompt: '', model });
  const once = (model) => adapter.runOneShot({ threadId: 'once', cwd: home, prompt: 'test', model });

  // No desktop or SDK cache: never fall back to the saved gpt-5.1 default.
  assert.deepEqual((await settings.getBubbleModelConfig()).options, []);
  await assert.rejects(start(undefined), /No Bubble models/);
  await assert.rejects(start('openai:gpt-5.1'), /No Bubble models/);
  await assert.rejects(once(undefined), /No Bubble models/);
  assert.equal(created, 0, 'invalid starts must not create orphan sessions');
  assert.deepEqual(sentModels, []);

  // Seed only the real SDK via HTTP; desktop must read it before refreshing.
  await sdk.registry.discoverModels(profile, { forceRefresh: true });
  assert.deepEqual((await settings.getBubbleModelConfig()).options, ['openai:gpt-catalog-fixture']);
  const diskPath = path.join(process.env.BUBBLE_HOME, 'model-discovery-cache.json');
  const disk = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
  for (const entry of Object.values(disk)) entry.expiresAt = Date.now() - 86400000;
  fs.writeFileSync(diskPath, JSON.stringify(disk));
  sdk.registry = makeRegistry();
  assert.equal(sdk.registry.getCachedDiscoverySnapshot('openai'), undefined, 'normal routing keeps its expiry policy');
  assert.deepEqual((await settings.getBubbleModelConfig()).options, ['openai:gpt-catalog-fixture'], 'desktop restores the last success even after expiry/restart');
  response = { status: 503, body: { error: 'fixture offline' } };
  const refreshing = settings.refreshBubbleModelCatalog();
  assert.deepEqual((await settings.getBubbleModelConfig()).options, ['openai:gpt-catalog-fixture'], 'refresh must not temporarily remove the last success');
  await refreshing;
  let config = await settings.getBubbleModelConfig();
  assert.deepEqual(config.options, ['openai:gpt-catalog-fixture']);
  assert.match(config.catalogNotice, /last successful/);
  assert.equal(config.defaultModel, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'bubble-model-catalog-cache.json'))).providers.openai.map(m => m.id), ['gpt-catalog-fixture']);

  await assert.rejects(start(undefined), /Select a Bubble model/);
  await assert.rejects(start('openai:gpt-5.1'), /no longer available/);
  await start('openai:gpt-catalog-fixture');
  await assert.rejects(adapter.sendTurn({ threadId: 'fixture', prompt: 'test', model: 'openai:gpt-5.1' }), /no longer available/);
  await adapter.sendTurn({ threadId: 'fixture', prompt: 'test' });
  // Drain the adapter's background turn before checking completion or retrying.
  while (adapter.sessions.get('fixture').turnActive) await new Promise(resolve => setImmediate(resolve));
  await once(undefined);
  assert.deepEqual(sentModels, ['openai:gpt-catalog-fixture', 'openai:gpt-catalog-fixture']);

  // A confirmed empty remote list supersedes every cache and session selection.
  response = { status: 200, body: { data: [] } };
  await settings.refreshBubbleModelCatalog();
  assert.deepEqual((await settings.getBubbleModelConfig()).options, []);
  await assert.rejects(adapter.sendTurn({ threadId: 'fixture', prompt: 'test' }), /No Bubble models/);
  await assert.rejects(once(undefined), /No Bubble models/);
  assert.equal(sentModels.length, 2);

  response = { status: 200, body: { data: [{ id: 'gpt-catalog-fixture' }] } };
  await settings.refreshBubbleModelCatalog();
  profile = { ...profile, apiKey: 'fixture-account-b' };
  response = { status: 503, body: { error: 'offline' } };
  await settings.refreshBubbleModelCatalog();
  config = await settings.getBubbleModelConfig();
  assert.deepEqual(config.options, [], 'neither desktop nor SDK may reuse another account cache');
  assert.match(config.catalogNotice, /Could not load/);
  await assert.rejects(start('openai:gpt-catalog-fixture'), /No Bubble models/);
  adapter.disposeSession('fixture');
  console.log('PASS: real SDK HTTP discovery, expired cache restore, offline desktop fallback, account isolation, empty success and start/send/one-shot guards');
}

app.whenReady().then(run).then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(code);
}

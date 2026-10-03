// Exercise desktop admission boundaries before SDK runTurn exists. No real API or profile.
const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.BUBBLE_PACKAGE_APP_PATH || path.resolve(__dirname, '../..');
const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bubble-startup-stop-'));
app.setPath('userData', path.join(home, 'desktop'));
app.setAppPath(root);
process.env.BUBBLE_HOME = path.join(home, 'agent');
fs.mkdirSync(process.env.BUBBLE_HOME);
fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'config.json'), JSON.stringify({
  defaultProvider: 'local-test', defaultModel: 'local-test:test',
  providers: [{ id: 'local-test', enabled: true, apiKey: 'fixture', baseURL: 'http://127.0.0.1:1/v1', protocol: 'openai' }],
}));
fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'models.json'), JSON.stringify({ providers: {
  'local-test': { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture', models: [{ id: 'test' }] },
} }));
const until = async (probe, label) => {
  for (let i = 0; i < 500; i++) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out: ' + label);
};
const gates = [];
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const result = { promise, release };
  gates.push(result);
  return result;
}
const requests = [], events = [], adapters = [];
let service;
const timeout = setTimeout(() => { console.error('Startup stop test timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const loader = require(path.join(root, 'dist-electron/electron/libs/provider/bubble-sdk-loader.js'));
  const { BubbleSdkAdapter } = require(path.join(root, 'dist-electron/electron/libs/provider/bubble-sdk-adapter.js'));
  const realGetSdk = loader.getBubbleSdk;
  const sdk = await realGetSdk(home);
  sdk.resolveProvider = () => ({ providerId: 'local-test', model: 'local-test:test', provider: {
    async *streamChat(messages) {
      requests.push(JSON.parse(JSON.stringify(messages)));
      yield { type: 'text', content: 'continued' };
      yield { type: 'done' };
    },
    async complete() { return ''; },
  } });
  const makeAdapter = () => {
    const adapter = new BubbleSdkAdapter();
    adapters.push(adapter);
    adapter.events.on('event', event => events.push(event));
    return adapter;
  };
  const input = (threadId, prompt, extra = {}) => ({
    threadId, provider: 'bubble', cwd: home, model: 'local-test:test', prompt,
    bubblePermissionMode: 'bypassPermissions', ...extra,
  });
  const completed = id => events.some(e => e.threadId === id && e.type === 'status_change' && e.status === 'completed');
  const nativeId = id => events.find(e => e.threadId === id && e.type === 'system_init').sessionId;
  const requestFor = prompt => requests.find(ms => ms.some(m => m.role === 'user' && m.content === prompt));
  const userCount = (id, text) => sdk.getHistory(id).filter(m => m.role === 'user' && JSON.stringify(m.content).includes(text)).length;

  // The SDK loader has not returned, but the runner must already have a durable
  // resume cursor to pass to an immediate replacement. Stopping waits for saving.
  const { runAgentLoop, ensureProviderService } = require(path.join(root, 'dist-electron/electron/libs/agent-loop.js'));
  const { getProviderService } = require(path.join(root, 'dist-electron/electron/libs/provider/service.js'));
  ensureProviderService(); service = getProviderService();
  service.events.on('event', event => events.push(event));
  const loading = gate();
  let loaderEntered = false, cursor;
  const errors = [];
  loader.getBubbleSdk = async (...args) => {
    if (!loaderEntered) { loaderEntered = true; await loading.promise; }
    return realGetSdk(...args);
  };
  const options = {
    session: { id: 'loader', provider: 'bubble', cwd: home }, model: 'local-test:test',
    bubblePermissionMode: 'bypassPermissions',
    onMessage: m => { if (m.type === 'system' && m.subtype === 'init') cursor = m.session_id; },
    onError: error => errors.push(error.message), onPermissionRequest: async () => ({ behavior: 'allow' }),
  };
  const old = runAgentLoop({ ...options, prompt: 'LOADER_ORIGINAL_43821' });
  await until(() => loaderEntered, 'SDK loader held');
  assert(cursor, 'cursor published before SDK loading yields');
  const firstCursor = cursor;
  old.abort();
  const replacement = runAgentLoop({ ...options, resumeSessionId: cursor, prompt: 'CONTINUE_LOADER' });
  assert.equal(requests.length, 0);
  loading.release();
  await until(() => completed('loader'), 'continued runner');
  loader.getBubbleSdk = realGetSdk;
  assert.equal(cursor, firstCursor);
  assert(JSON.stringify(requestFor('CONTINUE_LOADER')).includes('LOADER_ORIGINAL_43821'));
  assert.equal(requests.length, 1, 'stopped startup never invokes a model');
  assert.equal(userCount(cursor, 'LOADER_ORIGINAL_43821'), 1);
  assert.deepEqual(errors, []);
  replacement.abort();

  // Stop while metadata is pending. It must finish without waiting for the
  // catalog, and the late catalog response must not execute the stopped task.
  const catalogAdapter = makeAdapter(), catalog = gate();
  const resolveCatalog = catalogAdapter.resolveCatalogModel.bind(catalogAdapter);
  let catalogEntered = false;
  catalogAdapter.resolveCatalogModel = async (...args) => {
    catalogEntered = true; await catalog.promise; return resolveCatalog(...args);
  };
  const starting = catalogAdapter.startSession(input('catalog', 'CATALOG_ORIGINAL_92813'));
  await until(() => catalogEntered, 'catalog held');
  const catalogId = nativeId('catalog');
  await Promise.all([catalogAdapter.stopSession('catalog'), catalogAdapter.stopSession('catalog')]);
  await starting;
  assert.equal(userCount(catalogId, 'CATALOG_ORIGINAL_92813'), 1, 'repeated stop saves once');
  const fresh = makeAdapter();
  await fresh.startSession(input('catalog-resume', 'CONTINUE_CATALOG', { resumeSessionId: catalogId }));
  await until(() => completed('catalog-resume'), 'resume with fresh adapter');
  catalog.release();
  await new Promise(resolve => setImmediate(resolve));
  assert(JSON.stringify(requestFor('CONTINUE_CATALOG')).includes('CATALOG_ORIGINAL_92813'));
  assert.equal(requests.length, 2, 'late catalog result cannot start original task');
  assert(!completed('catalog'));

  // Stop during asynchronous image materialization; after saving, delete the
  // fixture so successful continuation proves actual image bytes were retained.
  const imagePath = path.join(home, 'image.png');
  fs.writeFileSync(imagePath, Buffer.from('fixture-image-bytes'));
  const reading = gate(), readFile = fsp.readFile;
  let readEntered = false;
  fsp.readFile = async (...args) => {
    if (args[0] === imagePath) { readEntered = true; await reading.promise; }
    return readFile(...args);
  };
  const images = makeAdapter();
  const imageStart = images.startSession(input('image', 'IMAGE_ORIGINAL_72914', {
    attachments: [{ id: 'image', kind: 'image', name: 'image.png', path: imagePath, mimeType: 'image/png' }],
  }));
  await until(() => readEntered, 'attachment read held');
  const imageId = nativeId('image');
  let stopFinished = false;
  const stoppingImage = images.stopSession('image').then(() => { stopFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopFinished, false, 'stop waits for attachment persistence');
  reading.release();
  await Promise.all([imageStart, stoppingImage]);
  fsp.readFile = readFile;
  fs.unlinkSync(imagePath);
  await fresh.startSession(input('image-resume', 'CONTINUE_IMAGE', { resumeSessionId: imageId }));
  await until(() => completed('image-resume'), 'image resume');
  const imageRequest = JSON.stringify(requestFor('CONTINUE_IMAGE'));
  assert(imageRequest.includes('IMAGE_ORIGINAL_72914'));
  assert(imageRequest.includes(Buffer.from('fixture-image-bytes').toString('base64')));
  assert.equal(userCount(imageId, 'IMAGE_ORIGINAL_72914'), 1);

  // Preparation also exists on a warm session, after older messages are durable.
  const warm = makeAdapter();
  const warmSession = await warm.startSession(input('warm', 'WARM_HISTORY_11235'));
  await until(() => completed('warm'), 'warm initial turn');
  const warmGate = gate();
  let warmEntered = false;
  warm.resolveCatalogModel = async () => { warmEntered = true; await warmGate.promise; return 'local-test:test'; };
  const sending = warm.sendTurn({ threadId: 'warm', prompt: 'WARM_PENDING_81321' });
  await until(() => warmEntered, 'warm preparation held');
  await warm.stopSession('warm'); await sending;
  await fresh.startSession(input('warm-resume', 'CONTINUE_WARM', { resumeSessionId: warmSession.providerSessionId }));
  await until(() => completed('warm-resume'), 'warm resume');
  warmGate.release();
  const warmRequest = JSON.stringify(requestFor('CONTINUE_WARM'));
  assert(warmRequest.includes('WARM_HISTORY_11235'));
  assert(warmRequest.includes('WARM_PENDING_81321'));
  assert.equal(userCount(warmSession.providerSessionId, 'WARM_PENDING_81321'), 1);
  assert.equal(events.filter(e => e.type === 'error').length, 0);
  console.log('PASS: SDK-loading stop, immediate runner resume, catalog cancellation, late response isolation, repeated stop, attachment persistence, fresh adapter recovery and warm preparation stop.');
}).then(async () => {
  await Promise.all(adapters.map(adapter => adapter.stopAll()));
  await service?.stopAll();
  clearTimeout(timeout); fs.rmSync(home, { recursive: true, force: true }); app.exit(0);
}, async error => {
  console.error(error); gates.forEach(item => item.release());
  clearTimeout(timeout); app.exit(1);
});

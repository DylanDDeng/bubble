// Real Bubble SDK + desktop adapter, with an in-process provider and disposable data.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bubble-steer-'));
const root = path.resolve(__dirname, '../..');
app.setPath('userData', path.join(dir, 'profile'));
app.setAppPath(root);
process.env.BUBBLE_HOME = path.join(dir, 'agent');
fs.mkdirSync(process.env.BUBBLE_HOME);
fs.writeFileSync(path.join(dir, 'fixture.txt'), 'steer fixture');
fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'config.json'), JSON.stringify({
  defaultProvider: 'local-test', defaultModel: 'local-test:test',
  providers: [{ id: 'local-test', enabled: true, apiKey: 'fixture', baseURL: 'http://127.0.0.1:1/v1', protocol: 'openai' }],
}));
fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'models.json'), JSON.stringify({ providers: {
  'local-test': { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture', models: [{ id: 'test' }] },
} }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (probe, label) => {
  for (let i = 0; i < 500; i++) { if (probe()) return; await delay(10); }
  throw Error('Timed out: ' + label);
};
const gates = new Map();
function gate(name) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  gates.set(name, { promise, release });
}
let adapter, sdk;
const requests = [], events = [], outcomes = [];
const timeout = setTimeout(() => { console.error('Bubble steer test timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const loader = require('../../dist-electron/electron/libs/provider/bubble-sdk-loader');
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter');
  sdk = await loader.getBubbleSdk(dir);
  sdk.resolveProvider = () => ({ providerId: 'local-test', model: 'local-test:test', provider: {
    async *streamChat(messages) {
      const prompt = [...messages].reverse().find(message => message.role === 'user')?.content;
      requests.push(prompt);
      if (gates.has(prompt)) await gates.get(prompt).promise;
      if (prompt === 'failed-fallback') throw Object.assign(new Error('fixture invalid request'), { status: 400 });
      if (prompt === 'initial-tool') {
        yield { type: 'tool_call', isStart: true, isEnd: true, id: 'read-fixture', name: 'read', arguments: JSON.stringify({ path: path.join(dir, 'fixture.txt') }) };
      } else if (['approval-followup', 'early-approval'].includes(prompt) && !messages.some(message => message.toolCallId === 'approval-tool')) {
        yield { type: 'tool_call', isStart: true, isEnd: true, id: 'approval-tool', name: 'bash', arguments: JSON.stringify({ command: 'printf approved > proof.txt' }) };
      } else yield { type: 'text', content: 'reply:' + prompt };
      yield { type: 'done' };
    },
    async complete() { return ''; },
  } });
  const originalSteer = sdk.steer.bind(sdk);
  sdk.steer = (...args) => {
    const result = originalSteer(...args);
    if (result.accepted) result.outcome.then(outcome => outcomes.push(outcome));
    return result;
  };
  adapter = new BubbleSdkAdapter();
  adapter.events.on('event', event => {
    events.push(event);
    if (event.type === 'permission_request') void adapter.respondToRequest(event.threadId, event.requestId, { behavior: 'allow' });
  });
  const completed = id => events.filter(event => event.threadId === id && event.type === 'status_change' && event.status === 'completed').length;
  const replies = id => events.filter(event => event.threadId === id && event.type === 'message' && event.message.type === 'assistant')
    .flatMap(event => event.message.message.content).filter(block => block.type === 'text').map(block => block.text);
  const start = (id, prompt) => adapter.startSession({ threadId: id, cwd: dir, prompt, model: 'local-test:test' });

  gate('initial-tool');
  await start('live', 'initial-tool');
  await until(() => requests.includes('initial-tool'), 'provider entered');
  await adapter.sendTurn({ threadId: 'live', prompt: 'live-steer' });
  gates.get('initial-tool').release();
  await until(() => completed('live') === 1, 'live steer completed');
  assert(outcomes.some(outcome => outcome.type === 'input_applied' && outcome.content === 'live-steer'));
  assert(replies('live').includes('reply:live-steer'));
  assert.equal(events.filter(event => event.threadId === 'live' && event.type === 'status_change' && event.status === 'running').length, 1);

  gate('initial-final'); gate('first-fallback');
  const fallback = await start('fallback', 'initial-final');
  await until(() => requests.includes('initial-final'), 'fallback original entered');
  await adapter.sendTurn({ threadId: 'fallback', prompt: 'first-fallback' });
  await adapter.sendTurn({ threadId: 'fallback', prompt: 'second-fallback' });
  gates.get('initial-final').release();
  await until(() => requests.includes('first-fallback'), 'SDK fallback started automatically');
  assert.equal(completed('fallback'), 0, 'desktop stays running through automatic fallback');
  gates.get('first-fallback').release();
  await until(() => completed('fallback') === 1, 'all fallbacks observed');
  assert.deepEqual(requests.filter(prompt => ['initial-final', 'first-fallback', 'second-fallback'].includes(prompt)), ['initial-final', 'first-fallback', 'second-fallback']);
  assert(replies('fallback').includes('reply:first-fallback'));
  assert(replies('fallback').includes('reply:second-fallback'));
  assert.equal(sdk.getSessionRunState(fallback.providerSessionId).active, false);
  const replyCount = replies('fallback').length;
  await adapter.sendTurn({ threadId: 'fallback', prompt: 'normal-next-turn' });
  await until(() => completed('fallback') === 2, 'normal warm followup');
  assert.equal(replies('fallback').length, replyCount + 1, 'new subscription does not replay old output');

  gate('before-approval');
  await start('approval', 'before-approval');
  await until(() => requests.includes('before-approval'), 'approval original');
  await adapter.sendTurn({ threadId: 'approval', prompt: 'approval-followup' });
  gates.get('before-approval').release();
  await until(() => completed('approval') === 1, 'fallback approval callback');
  assert(events.some(event => event.threadId === 'approval' && event.type === 'permission_request'));
  assert.equal(fs.readFileSync(path.join(dir, 'proof.txt'), 'utf8'), 'approved');

  gate('before-early-steer');
  let earlySend;
  const steerOnRunning = event => {
    if (event.threadId === 'early' && event.type === 'status_change' && event.status === 'running') {
      earlySend = adapter.sendTurn({ threadId: 'early', prompt: 'early-approval' });
    }
  };
  adapter.events.on('event', steerOnRunning);
  await start('early', 'before-early-steer');
  assert(earlySend, 'running notification allows immediate follow-up');
  await earlySend;
  adapter.events.off('event', steerOnRunning);
  gates.get('before-early-steer').release();
  await until(() => completed('early') === 1, 'early steering completes');
  assert(events.some(event => event.threadId === 'early' && event.type === 'permission_request'), 'early steer inherits approval callbacks');
  assert(replies('early').includes('reply:early-approval'));

  gate('before-stop'); gate('blocked-fallback');
  const stopped = await start('stop', 'before-stop');
  await until(() => requests.includes('before-stop'), 'stop original');
  await adapter.sendTurn({ threadId: 'stop', prompt: 'blocked-fallback' });
  await adapter.sendTurn({ threadId: 'stop', prompt: 'must-not-run' });
  gates.get('before-stop').release();
  await until(() => requests.includes('blocked-fallback'), 'fallback before stop');
  const stopping = adapter.stopSession('stop');
  gates.get('blocked-fallback').release();
  await stopping;
  await until(() => !sdk.getSessionRunState(stopped.providerSessionId).active, 'stop settles SDK');
  assert.equal(requests.includes('must-not-run'), false, 'stop cancels SDK fallback queue');
  assert.equal(completed('stop'), 0, 'stopped session never becomes completed');
  assert.equal(events.filter(event => event.type === 'error').length, 0);

  gate('before-failure');
  const failed = await start('failure', 'before-failure');
  await until(() => requests.includes('before-failure'), 'failure original entered');
  await adapter.sendTurn({ threadId: 'failure', prompt: 'failed-fallback' });
  gates.get('before-failure').release();
  await until(() => events.some(event => event.threadId === 'failure' && event.type === 'error'), 'fallback failure surfaced');
  assert.equal(completed('failure'), 0, 'fallback failure cannot report successful completion');
  assert.equal(sdk.getSessionRunState(failed.providerSessionId).active, false);
  assert.equal(sdk.getSessionRunState(failed.providerSessionId).queuedTurns, 0);
  await adapter.sendTurn({ threadId: 'failure', prompt: 'retry-after-failure' });
  await until(() => completed('failure') === 1, 'new turn after fallback failure');
  assert(replies('failure').includes('reply:retry-after-failure'));
  console.log('PASS: live and immediate steer, FIFO fallback, warm cursor, inherited approvals, stop cancellation, failure recovery');
}).then(async () => {
  await adapter?.stopAll();
  clearTimeout(timeout);
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
}, async error => {
  console.error(error);
  for (const entry of gates.values()) entry.release();
  await adapter?.stopAll();
  clearTimeout(timeout);
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(1);
});

// Adapter boundary regression: disposable desktop/agent data, no credentials.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-stream-perf-'));
app.setPath('userData', path.join(dir, 'profile'));
process.env.BUBBLE_HOME = path.join(dir, 'agent');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter');
  const adapter = new BubbleSdkAdapter(), events = [];
  const session = { threadId: 'perf', currentAssistant: null, pendingRequests: new Map(), status: 'running' };
  adapter.events.on('event', event => events.push(event));
  const text = 'streaming content ';
  const start = performance.now();
  for (let i = 0; i < 12000; i++) adapter.handleBubbleEvent(session, { type: 'text_delta', content: text });
  adapter.emit({ type: 'status_change', threadId: 'perf', status: 'completed' });
  const deltas = events.filter(e => e.message?.type === 'stream_event');
  assert.equal(deltas.map(e => e.message.event.delta.text).join(''), text.repeat(12000));
  assert(deltas.length < 100, 'bursts are batched before synchronous main-process/IPC work');
  assert.equal(events.at(-1).type, 'status_change');
  console.log(JSON.stringify({ inputDeltas: 12000, outgoingDeltas: deltas.length, chars: 12000 * text.length, elapsedMs: Math.round(performance.now() - start) }));

  for (const boundary of ['permission_request', 'error', 'status_change']) {
    events.length = 0;
    adapter.handleBubbleEvent(session, { type: 'reasoning_delta', content: 'pending' });
    adapter.emit({ type: boundary, threadId: 'perf' });
    assert.equal(events[0].message.event.delta.thinking, 'pending');
    assert.equal(events[1].type, boundary);
  }
  events.length = 0;
  adapter.handleBubbleEvent(session, { type: 'text_delta', content: 'timer tail' });
  await delay(60);
  assert.equal(events[0].message.event.delta.text, 'timer tail');
  adapter.sessions.set('perf', session);
  adapter.handleBubbleEvent(session, { type: 'text_delta', content: 'discarded' });
  adapter.disposeSession('perf');
  await delay(60);
  assert.equal(events.length, 1, 'disposed sessions emit no stale buffered tail');
  console.log('PASS: coalesced text preserved; status, approval and error ordering; deadline; disposal');
}).then(() => { fs.rmSync(dir, { recursive: true, force: true }); app.exit(0); }, e => { console.error(e); app.exit(1); });

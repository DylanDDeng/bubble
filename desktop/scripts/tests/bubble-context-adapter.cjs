const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-qa-'));
app.setPath('userData', path.join(dir, 'profile')); process.env.BUBBLE_HOME = path.join(dir, 'agent');
app.whenReady().then(() => {
  const store = require('../../dist-electron/electron/libs/session-store');
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter');
  store.initialize();
  const stored = store.createSession({ title: 'Context fixture', provider: 'bubble', cwd: dir });
  const adapter = new BubbleSdkAdapter();
  const messages = [];
  adapter.events.on('event', e => { if (e.message) { messages.push(e.message); store.addMessage(stored.id, e.message); } });
  const session = { threadId: stored.id, model: 'openai:gpt-6-astra', contextWindow: 272000, currentAssistant: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, totalCostUsd: 0, durationStartMs: Date.now() };
  for (let i = 0; i < 11; i++) {
    adapter.handleBubbleEvent(session, { type: 'context_usage', usedTokens: 79228, contextWindow: 272000, estimated: false });
    adapter.handleBubbleEvent(session, { type: 'turn_end', usage: { promptTokens: 78449, completionTokens: 779, promptCacheHitTokens: 76032, totalTokens: 79228 } });
  }
  assert.equal(session.usage.total_tokens, 79228 * 11);
  assert.equal(messages.filter(m => m.subtype === 'bubble_context').at(-1).context.usedTokens, 79228);
  adapter.handleBubbleEvent(session, { type: 'context_compaction', status: 'started', preTokens: 240000, contextWindow: 272000 });
  assert.equal(messages.at(-1).status, 'started');
  adapter.handleBubbleEvent(session, { type: 'context_compaction', status: 'completed', preTokens: 240000, postTokens: 30000, contextWindow: 272000, compactionId: 'checkpoint-1', persisted: true });
  assert.equal(messages.at(-2).subtype, 'compact_boundary');
  assert.deepEqual(messages.at(-2).compactMetadata, { trigger: 'auto', preTokens: 240000, postTokens: 30000, compactionId: 'checkpoint-1', persisted: true });
  assert.equal(messages.at(-2).uuid, 'bubble-compact:checkpoint-1');
  assert.equal(messages.at(-1).context.usedTokens, 30000);
  adapter.handleBubbleEvent(session, { type: 'context_compaction', status: 'started', preTokens: 240000 });
  adapter.handleBubbleEvent(session, { type: 'context_compaction', status: 'failed', preTokens: 240000 });
  assert.equal(messages.at(-1).status, 'failed');
  assert.equal(messages.filter(m => m.subtype === 'compact_boundary').length, 1, 'failed attempt creates no fake completed boundary');
  adapter.emitResult(session);
  assert.equal(messages.at(-1).usage.total_tokens, 79228 * 11);
  store.close(); store.initialize();
  const history = store.getSessionHistory(stored.id);
  assert.equal(history.filter(m => m.subtype === 'bubble_context').at(-1).context.usedTokens, 30000);
  assert.equal(history.filter(m => m.subtype === 'compact_boundary').length, 1);
  assert.equal(history.find(m => m.subtype === 'compact_boundary').compactMetadata.persisted, true);
  assert.equal(history.find(m => m.subtype === 'compact_boundary').compactMetadata.compactionId, 'checkpoint-1');

  // Probe retransmission and older SDK compatibility without changing the UI fixture.
  const replayAdapter = new BubbleSdkAdapter(), replay = [];
  replayAdapter.events.on('event', e => { if (e.message) replay.push(e.message); });
  const completed = { type: 'context_compaction', status: 'completed', preTokens: 240000, compactionId: 'checkpoint-replay', persisted: true };
  replayAdapter.handleBubbleEvent(session, completed);
  replayAdapter.handleBubbleEvent(session, completed);
  assert.equal(replay[0].uuid, replay[1].uuid, 'checkpoint replay uses a stable boundary UUID');
  replayAdapter.handleBubbleEvent(session, { ...completed, compactionId: 'not-committed', persisted: false });
  assert.equal(replay.at(-1).compactMetadata.persisted, false);
  replayAdapter.handleBubbleEvent(session, { type: 'context_compaction', status: 'completed', preTokens: 240000 });
  const legacy = replay.at(-1);
  assert.equal(legacy.subtype, 'compact_boundary', 'legacy completions remain visible');
  assert.equal(legacy.compactMetadata.persisted, undefined);
  assert.equal(legacy.compactMetadata.compactionId, undefined);
  assert.ok(legacy.uuid);
  replayAdapter.handleBubbleEvent(session, { type: 'context_compaction', status: 'completed', preTokens: 240000 });
  assert.notEqual(replay.at(-1).uuid, legacy.uuid, 'legacy completions retain unique UUIDs');
  // Replay through SQLite, including a reopen and a later turn between receipts.
  // Keep this separate from the UI rendering fixture above.
  const replayStored = store.createSession({ title: 'Replay ordering', provider: 'bubble', cwd: dir });
  const replayBoundary = replay[0];
  const originalNow = Date.now;
  try {
    Date.now = () => 1000;
    store.addMessage(replayStored.id, replayBoundary);
    Date.now = () => 2000;
    store.addMessage(replayStored.id, { type: 'user_prompt', uuid: 'after-checkpoint', prompt: 'next turn' });
    store.close(); store.initialize();
    Date.now = () => 3000;
    store.addMessage(replayStored.id, { ...replayBoundary,
      compactMetadata: { ...replayBoundary.compactMetadata, postTokens: 12345 } });
    // An explicit retransmission timestamp must not move the boundary either.
    store.addMessage(replayStored.id, { ...replayBoundary, createdAt: 4000,
      compactMetadata: { ...replayBoundary.compactMetadata, postTokens: 9999 } });
    store.close(); store.initialize();
    const replayHistory = store.getSessionHistory(replayStored.id);
    assert.deepEqual(replayHistory.map(m => m.uuid), [replayBoundary.uuid, 'after-checkpoint']);
    assert.equal(replayHistory[0].createdAt, 1000, 'boundary retains its first persisted timestamp');
    assert.equal(replayHistory[0].compactMetadata.postTokens, 9999, 'receipt payload can still be updated');
    assert.equal(replayHistory[1].createdAt, 2000);
    // Non-boundary upserts keep their existing timestamp update semantics.
    store.addMessage(replayStored.id, { type: 'user_prompt', uuid: 'after-checkpoint', prompt: 'updated', createdAt: 5000 });
    assert.equal(store.getStoredMessage(replayStored.id, 'after-checkpoint').createdAt, 5000);
  } finally {
    Date.now = originalNow;
  }
  if (process.env.BUBBLE_CONTEXT_FIXTURE) fs.writeFileSync(process.env.BUBBLE_CONTEXT_FIXTURE, JSON.stringify(history));
  store.close();
  console.log('PASS: adapter context/compaction events persist and survive database reopen; cumulative billing stays separate');
}).then(() => { fs.rmSync(dir, { recursive: true, force: true }); app.exit(0); }, e => { console.error(e); app.exit(1); });

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-history-context-qa-'));
app.setPath('userData', path.join(dir, 'profile'));
process.env.BUBBLE_HOME = path.join(dir, 'agent');

app.whenReady().then(async () => {
  const store = require('../../dist-electron/electron/libs/session-store');
  const { recoverBubbleHistoryContext: recover } = require('../../dist-electron/electron/libs/bubble-history-context');
  const { getHistorySourceForSession, toUnifiedSessionRecord } = require('../../dist-electron/electron/libs/history/registry');
  store.initialize();
  const model = 'openai:gpt-6-astra';
  const stored = store.createSession({ title: 'Legacy context fixture', provider: 'bubble', cwd: dir });
  store.setBubbleSessionId(stored.id, 'legacy');
  store.updateSessionModel(stored.id, model);
  store.updateSessionStatus(stored.id, 'completed');
  const row = () => store.getSession(stored.id);
  const result = { type: 'result', subtype: 'success', uuid: 'old-billing', model,
    duration_ms: 1000, total_cost_usd: 0,
    usage: { input_tokens: 801160, output_tokens: 1870, total_tokens: 803030, context_window: 272000 } };
  const file = path.join(process.env.BUBBLE_HOME, 'sessions', dir.replace(/[/\\:]/g, '_'), 'legacy.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const assistant = (timestamp = 200, used = 78449) => ({ id: 'last', type: 'assistant_message', timestamp,
    message: { role: 'assistant', model, providerId: 'openai', modelId: 'gpt-6-astra',
      usage: { promptTokens: used, completionTokens: 779, promptCacheHitTokens: 76032, totalTokens: 79228 } } });
  const write = entries => fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const unknown = async (reason, entries, messages = [result], overrides = {}) => {
    write(entries);
    assert.equal(await recover({ ...row(), ...overrides }, messages), null, reason);
  };
  write([assistant()]);
  const recovered = await recover(row(), [result]);
  assert.equal(recovered?.context.usedTokens, 79228, 'only last call, cache already included');
  assert.equal(recovered.context.contextWindow, 272000);
  assert.equal(recovered.context.estimated, false);
  assert.equal((await recover(row(), [result])).uuid, recovered.uuid, 'stable identity');
  const activeHome = process.env.BUBBLE_HOME;
  process.env.BUBBLE_HOME = path.join(dir, 'another-profile');
  assert.equal(await recover(row(), [result]), null, 'does not fall back to another data profile');
  process.env.BUBBLE_HOME = activeHome;
  await unknown('summary newer than retained assistant invalidates stale measurement', [
    { id: 'summary', type: 'summary', summary: 'short', timestamp: 300 }, assistant(),
  ]);
  write([{ id: 'summary', type: 'summary', summary: 'short', timestamp: 150 }, assistant()]);
  assert.equal((await recover(row(), [result])).context.usedTokens, 79228, 'post-compaction measurement is valid');
  for (const kind of ['conversation_clear', 'model_switch', 'provider_switch', 'runtime_switch']) {
    await unknown(kind, [assistant(), { id: kind, type: 'marker', kind, timestamp: 300 }]);
  }
  await unknown('new unanswered turn cannot reuse old usage', [assistant(), { type: 'user_message', timestamp: 300, message: { role: 'user', content: 'next' } }]);
  await unknown('latest assistant has no usage', [assistant(), { type: 'assistant_message', timestamp: 300, message: { role: 'assistant', model } }]);
  await unknown('wrong selected model', [assistant()], [result], { model: 'other:model' });
  await unknown('running session race', [assistant()], [result], { status: 'running' });
  await unknown('unknown window', [assistant()], [{ ...result, usage: { total_tokens: 803030 } }]);
  await unknown('child billing cannot supply parent capacity', [assistant()], [{ ...result, parentToolUseId: 'child' }]);
  await unknown('existing runtime snapshot wins', [assistant()], [result, recovered]);
  await unknown('explicit invalidation wins', [assistant()], [result, { ...recovered, context: null }]);
  await unknown('external runtime mirror is unsupported', [{ type: 'metadata', timestamp: 1, metadata: { externalRuntime: { id: 'grok' } } }, assistant()]);
  await unknown('unsafe native ID', [assistant()], [result], { bubble_session_id: '../child' });
  await unknown('invalid usage', [{ ...assistant(), message: { model, usage: { promptTokens: -1, completionTokens: 2 } } }]);
  write([{ id: 'legacy', type: 'message', data: assistant().message, timestamp: 200 }]);
  assert.equal((await recover(row(), [result])).context.usedTokens, 79228, 'legacy message format');
  await unknown('legacy compaction', [{ type: 'compaction', timestamp: 300, summary: 'short' }, { type: 'message', data: assistant().message, timestamp: 200 }]);
  write([assistant(100, 1000)]);
  assert.equal((await recover(row(), [result])).context.usedTokens, 1779, 'rewritten/rewound native log is reread');
  fs.appendFileSync(file, '{broken');
  assert.equal(await recover(row(), [result]), null, 'partial/corrupt native log');
  fs.unlinkSync(file);
  fs.mkdirSync(path.join(path.dirname(file), 'legacy.subagents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(file), 'legacy.subagents', 'child.jsonl'), JSON.stringify(assistant()));
  assert.equal(await recover(row(), [result]), null, 'missing parent never searches child logs');

  // Real database/history path: opening an old conversation is sufficient.
  write([assistant()]);
  for (let i = 0; i < 8; i++) store.addMessage(stored.id, { type: 'user_prompt', uuid: `prompt-${i}`, prompt: `old ${i}`, createdAt: 1000 + i });
  store.addMessage(stored.id, { ...result, createdAt: 2000 });
  store.close(); store.initialize();
  const unified = toUnifiedSessionRecord(row());
  const source = getHistorySourceForSession(unified);
  const original = store.getSessionHistory(stored.id);
  const bytes = fs.readFileSync(file, 'utf8');
  const page = await source.loadLatest(unified, 2);
  assert.equal(page.messages.at(-1).context.usedTokens, 79228);
  assert.equal(page.cursor, '7', 'synthetic telemetry does not consume pagination offsets');
  assert.equal(page.hasMore, true);
  assert.equal((await source.loadLatest(unified, 2)).messages.at(-1).uuid, page.messages.at(-1).uuid);
  assert.equal((await source.loadBefore(unified, page.cursor, 2)).messages.length, 2);
  assert.deepEqual(store.getSessionHistory(stored.id), original, 'no DB migration or duplicate events');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'native history untouched');
  if (process.env.BUBBLE_LEGACY_CONTEXT_FIXTURE) fs.writeFileSync(process.env.BUBBLE_LEGACY_CONTEXT_FIXTURE, JSON.stringify(page.messages));
  const fresh = { ...recovered, uuid: 'live', createdAt: 3000, context: { ...recovered.context, usedTokens: 1234 } };
  const opening = source.loadLatest(unified, 2);
  store.addMessage(stored.id, fresh);
  const racedPage = await opening;
  assert.equal(racedPage.messages.at(-1).uuid, 'live', 'runtime event arriving during recovery wins');
  assert.equal(racedPage.messages.filter(m => m.subtype === 'bubble_context').length, 1, 'no stale synthetic tail after live snapshot');
  assert.equal((await source.loadLatest(unified, 2)).messages.at(-1).context.usedTokens, 1234, 'fresh runtime data takes priority');
  store.close();
  console.log('PASS: legacy native usage recovery, compaction/clear/model guards, read-only history pagination and reopen');
}).then(() => { fs.rmSync(dir, { recursive: true, force: true }); app.exit(0); }, error => {
  console.error(error); fs.rmSync(dir, { recursive: true, force: true }); app.exit(1);
});

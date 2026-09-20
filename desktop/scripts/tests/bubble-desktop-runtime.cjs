// Headless integration: real Electron native ABI + local SDK + local provider.
// No renderer automation, account credentials, or external model requests.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const root = process.env.BUBBLE_PACKAGE_APP_PATH || path.resolve(__dirname, '../..');
const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bubble-parity-test-'));
app.setPath('userData', home);
app.setAppPath(root);
process.env.BUBBLE_HOME = path.join(home, 'agent');
fs.mkdirSync(process.env.BUBBLE_HOME);
let server;
let store;
let lsp;
let releaseChild;
const childGate = new Promise(resolve => { releaseChild = resolve; });
let childStarted;
const childReady = new Promise(resolve => { childStarted = resolve; });
let childFollowups = 0;
const timeout = setTimeout(() => { console.error('Integration timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const last = request.messages.at(-1);
    const editTurn = request.messages.some(message => message.role === 'user' && message.content === 'Test TypeScript edit');
    const parentProbe = request.messages.some(message => message.role === 'user' && message.content === 'Test subagent queue');
    const childProbe = request.messages.some(message => message.role === 'user' && message.content === 'Child queue probe');
    let call;
    let responseText = 'Bubble desktop works.';
    if (parentProbe) {
      if (!request.messages.some(message => message.tool_call_id === 'spawn-probe')) {
        call = { id: 'spawn-probe', name: 'spawn_agent', arguments: { agent_type: 'explorer', description: 'Queue integration', message: 'Child queue probe' } };
      } else if (!request.messages.some(message => message.tool_call_id === 'send-probe')) {
        await childReady;
        const spawned = request.messages.find(message => message.tool_call_id === 'spawn-probe');
        const agentId = spawned.content.match(/agent_id: ([\w-]+)/)?.[1];
        assert(agentId, 'spawn tool returned child identity');
        call = { id: 'send-probe', name: 'send_input', arguments: { agent_id: agentId, message: 'Supplementary queue probe' } };
      } else if (!request.messages.some(message => message.tool_call_id === 'wait-probe')) {
        assert(request.messages.find(message => message.tool_call_id === 'send-probe').content.includes('Queued input for'));
        releaseChild();
        call = { id: 'wait-probe', name: 'wait_agent', arguments: { timeout_ms: 5000 } };
      }
    }
    if (childProbe) {
      childStarted();
      await childGate;
      const count = request.messages.filter(message => message.role === 'user' && message.content === 'Supplementary queue probe').length;
      if (count) { assert.equal(count, 1); childFollowups += 1; }
      responseText = count ? 'Supplementary queue probe applied successfully.' : 'Initial child response.';
    }
    if (last?.content === 'Test approval') call = { id: 'test-call', name: 'bash', arguments: { command: 'printf verified > approval-proof.txt' } };
    if (editTurn && last?.role === 'user') call = { id: 'read-call', name: 'read', arguments: { path: 'example.ts' } };
    if (editTurn && last?.tool_call_id === 'read-call') call = { id: 'edit-call', name: 'edit', arguments: { path: 'example.ts', edits: [{ oldText: 'value: number = 1', newText: 'value: number = "invalid"' }] } };
    const needsTool = !!call;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = needsTool ? { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: 'assistant', content: responseText };
    for (const frame of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: needsTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } },
    ]) res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'test', ...frame })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'config.json'), JSON.stringify({ defaultProvider: 'local-test', defaultModel: 'local-test:test', providers: [{ id: 'local-test', name: 'Local fixture', enabled: true, apiKey: 'fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai' }] }));
  fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'models.json'), JSON.stringify({ providers: { 'local-test': { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture', models: [{ id: 'test' }] } } }));
  fs.mkdirSync(path.join(process.env.BUBBLE_HOME, 'skills/check'), { recursive: true });
  fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'skills/check/SKILL.md'), '---\nname: desktop-check\ndescription: Check the desktop\n---\n# Desktop check\nRead the project.');
  const { BubbleSdkAdapter } = require(path.join(root, 'dist-electron/electron/libs/provider/bubble-sdk-adapter.js'));
  const { getBubbleSdk, readBubbleSkillContent } = require(path.join(root, 'dist-electron/electron/libs/provider/bubble-sdk-loader.js'));
  const { importBubbleHistory, bubbleHistoryMessages } = require(path.join(root, 'dist-electron/electron/libs/bubble-history-import.js'));
  store = require(path.join(root, 'dist-electron/electron/libs/session-store.js'));
  store.initialize();
  const instances = await Promise.all(Array.from({length: 20}, () => getBubbleSdk(home)));
  const sdk = instances[0];
  assert(instances.every(instance => instance === sdk), 'concurrent callers share exactly one SDK');
  const adapter = new BubbleSdkAdapter();
  const events = [];
  const finished = new Promise((resolve, reject) => {
    adapter.events.on('event', event => {
      events.push(event);
      if (event.type === 'permission_request') void adapter.respondToRequest(event.threadId, event.requestId, { behavior: 'allow' });
      if (event.type === 'error') reject(event.error);
      if (event.type === 'status_change' && event.status === 'completed') resolve();
    });
  });
  const session = await adapter.startSession({ threadId: 'integration', provider: 'bubble', cwd: home, prompt: 'Test approval', model: 'local-test:test', bubblePermissionMode: 'default' });
  await finished;
  assert(events.some(event => event.type === 'permission_request'), 'real tool approval crossed adapter');
  assert.equal(fs.readFileSync(path.join(home, 'approval-proof.txt'), 'utf8'), 'verified');
  assert(events.some(event => event.type === 'message' && event.message.type === 'assistant' && JSON.stringify(event.message).includes('Bubble desktop works.')));
  assert(sdk.getHistory(session.providerSessionId).length >= 4, 'turn persisted in SDK');
  assert.equal((await readBubbleSkillContent('desktop-check', home)).ok, true);
  assert.equal((await readBubbleSkillContent('../../config.json', home)).ok, false);
  assert.equal(await importBubbleHistory(), 1);
  assert.equal(await importBubbleHistory(), 0, 'migration is idempotent');
  const imported = store.listSessions()[0];
  assert.equal(imported.bubble_session_id, session.providerSessionId);
  assert.equal(imported.session_origin, 'bubble_imported');
  assert.equal(imported.status, 'idle', 'history import does not claim success');
  assert(store.getSessionHistory(imported.id).some(message => message.type === 'assistant'));
  assert.equal(bubbleHistoryMessages([{ role: 'assistant', toolCalls: [{ id: 'x', name: 'bash', arguments: '{broken' }] }], 'bad')[0].message.content[0].input.raw, '{broken');
  const automation = store.saveAutomation({ name: 'Smoke', projectCwd: home, prompt: 'Say hello', schedule: { kind: 'interval', intervalMinutes: 60 }, runtime: { provider: 'bubble', model: 'local-test:test' }, enabled: false });
  assert.equal(automation.runtime.provider, 'bubble');
  const { AutomationScheduler } = require(path.join(root, 'dist-electron/electron/libs/automation-scheduler.js'));
  let scheduled;
  const scheduler = new AutomationScheduler(async payload => { scheduled = payload; return imported.id; }, () => {});
  const result = await scheduler.runNow(automation.id);
  assert.equal(result.ok, true);
  assert.equal(scheduled.provider, 'bubble');
  // Exercise the path missing from the original package smoke: real TS edit,
  // real language server + tsserver subprocess, tool result, next model turn.
  fs.writeFileSync(path.join(home, 'package.json'), '{"private":true}');
  fs.writeFileSync(path.join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["example.ts"]}');
  fs.writeFileSync(path.join(home, 'example.ts'), 'export const value: number = 1;\n');
  const { getLspService } = await import(require('node:url').pathToFileURL(path.join(root, 'runtime/bubble/dist/lsp/service.js')).href);
  lsp = getLspService(home);
  const editEvents = [];
  const edited = new Promise((resolve, reject) => {
    adapter.events.on('event', event => {
      if (event.threadId !== 'lsp-integration') return;
      editEvents.push(event);
      if (event.type === 'error') reject(event.error);
      if (event.type === 'status_change' && event.status === 'completed') resolve();
    });
  });
  await adapter.startSession({ threadId: 'lsp-integration', provider: 'bubble', cwd: home, prompt: 'Test TypeScript edit', model: 'local-test:test', bubblePermissionMode: 'bypassPermissions' });
  await edited;
  assert(fs.readFileSync(path.join(home, 'example.ts'), 'utf8').includes('= "invalid"'));
  assert(lsp.status().some(status => status.id === 'typescript' && status.status === 'connected'), JSON.stringify(lsp.status()));
  assert(Object.values(lsp.diagnostics()).flat().some(diagnostic => diagnostic.message.includes('not assignable')), 'real tsserver returned diagnostics');
  assert(editEvents.some(event => event.type === 'message' && JSON.stringify(event.message).includes('Bubble desktop works.')), 'Agent continued after edit');
  await lsp.shutdown();
  const childSession = store.createSession({ provider: 'bubble', title: 'Isolated subagent probe', cwd: home });
  const childStates = [];
  const childFinished = new Promise((resolve, reject) => {
    adapter.events.on('event', event => {
      if (event.threadId !== childSession.id) return;
      if (event.type === 'message') {
        store.addMessage(childSession.id, event.message);
        if (event.message.bubbleSubagent) childStates.push(event.message.bubbleSubagent);
      }
      if (event.type === 'error') reject(event.error);
      if (event.type === 'status_change' && event.status === 'completed') resolve();
    });
  });
  await adapter.startSession({ threadId: childSession.id, provider: 'bubble', cwd: home, prompt: 'Test subagent queue', model: 'local-test:test', bubblePermissionMode: 'bypassPermissions' });
  await childFinished;
  assert.equal(childFollowups, 1, 'queued input continued the tool-free child exactly once');
  assert(childStates.some(state => state.inputDelivery === 'queued'));
  assert(childStates.some(state => state.inputDelivery === 'applied'));
  assert.equal(childStates.at(-1).status, 'completed');
  store.close(); store.initialize();
  const restoredStates = store.getSessionHistory(childSession.id).filter(message => message.bubbleSubagent);
  assert.equal(restoredStates.length, 1, 'SQLite upserts and restores one child state');
  assert.deepEqual(restoredStates[0].bubbleSubagent, childStates.at(-1));
  await adapter.stopAll();
  console.log('PASS: local SDK, approval, tool execution, streamed final, persisted history, skill detail, history migration, Bubble automation routing, TypeScript edit + real LSP + continued Agent turn, subagent queue + wait + SQLite restore');
}).then(() => { clearTimeout(timeout); server.close(); store.close(); fs.rmSync(home, {recursive: true, force: true}); app.exit(0); }).catch(error => { lsp?.shutdownNow(); console.error(error); clearTimeout(timeout); server?.close(); app.exit(1); });

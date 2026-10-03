// No model, credentials, desktop windows, or persistent user data are used.
// Run with Node (Node-ABI better-sqlite3) or scripts/launch-electron.mjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.env.TURN_FAILURE_FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-turn-failure-'));
  let failed = false;
  try {
    for (const phase of ['write', 'read']) {
      const result = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, TURN_FAILURE_FIXTURE: dir, TURN_FAILURE_PHASE: phase,
          BUBBLE_HOME: path.join(dir, 'bubble-home'), HOME: dir },
        encoding: 'utf8', timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
      process.stdout.write(result.stdout);
    }
  } catch (error) {
    console.error(error);
    failed = true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (process.versions.electron) require('electron').app.exit(failed ? 1 : 0);
  else process.exitCode = failed ? 1 : 0;
} else {
  run().then(() => exit(0), error => { console.error(error); exit(1); });
}

function exit(code) {
  if (process.versions.electron) require('electron').app.exit(code);
  else process.exitCode = code;
}

async function run() {
  const dir = process.env.TURN_FAILURE_FIXTURE;
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // Set Electron paths before readiness as well as stubbing the shell below.
  if (process.versions.electron) {
    const { app } = require('electron');
    app.setPath('userData', profile);
    app.setPath('sessionData', path.join(dir, 'session-data'));
  }
  const { load, startRunner, runnerHandles, callbacks, broadcasts, service, control } =
    require('./turn-failure-runtime.cjs').createRuntime(profile);
  const sessions = load('libs/session-store.ts');
  sessions.initialize();
  try {
    if (process.env.TURN_FAILURE_PHASE === 'read') {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
      for (const { id, history, status } of saved) {
        assert.deepEqual(sessions.getSessionHistory(id), history, 'fresh process reads identical ordered history');
        assert.equal(sessions.getSession(id).status, status);
      }
      console.log('PASS: fresh process reopened all producer-written SQLite histories');
      return;
    }

    const ids = [];
    const create = () => {
      const session = sessions.createSession({ title: 'Isolated failure regression', cwd: dir, provider: 'bubble' });
      ids.push(session.id);
      return session;
    };
    const prompt = (session, text) => {
      sessions.addMessage(session.id, { type: 'user_prompt', prompt: text, createdAt: Date.now() });
      sessions.updateSessionStatus(session.id, 'running');
    };
    const start = (session, text) => {
      prompt(session, text);
      startRunner({}, sessions.getSession(session.id), text, undefined, undefined, 'bubble', 'fixture:model');
      return callbacks.at(-1);
    };
    const history = session => sessions.getSessionHistory(session.id);
    const failures = session => history(session).filter(m => m.type === 'turn_failure');
    const events = session => broadcasts.filter(e => e.payload.sessionId === session.id);
    const waitFor = async (predicate, description) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail(`Timed out: ${description}`);
    };
    const checkFailure = (session, message, count = 1) => {
      const rows = failures(session);
      assert.equal(rows.length, count, 'exactly one durable failure per live failed turn');
      const row = rows.at(-1);
      assert.equal(row.error, message);
      assert.match(row.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.ok(Number.isFinite(row.createdAt) && row.createdAt > 0);
      assert.equal(sessions.getSession(session.id).status, 'error');
      const tail = events(session).slice(-3);
      assert.deepEqual(tail.map(e => e.type), ['stream.message', 'session.status', 'runner.error']);
      assert.deepEqual(tail[0].payload.message, row, 'broadcast is the exact persisted producer record');
      assert.equal(tail[1].payload.status, 'error');
      assert.equal(tail[2].payload.message, message);
      assert.equal(runnerHandles.has(session.id), false, 'failed handle is retired');
    };

    // SDK load rejects before system_init/result: real startPromise.catch -> onError.
    const cold = create();
    control.loadError = new Error('Same connection failure');
    const coldCallbacks = start(cold, 'first failed prompt');
    await waitFor(() => failures(cold).length === 1, 'cold start rejection');
    checkFailure(cold, 'Same connection failure');
    assert.equal(history(cold).some(m => m.type === 'result'), false);
    const coldBefore = history(cold);
    const eventCount = broadcasts.length;
    coldCallbacks.onError(new Error('duplicate callback'));
    coldCallbacks.onError(new Error('duplicate callback'));
    assert.deepEqual(history(cold), coldBefore);
    assert.equal(broadcasts.length, eventCount, 'duplicates do not emit additional random-UUID records');

    // Identical text on a DIFFERENT turn must not be deduped by message text.
    start(cold, 'second failed prompt');
    await waitFor(() => failures(cold).length === 2, 'second cold failure');
    checkFailure(cold, 'Same connection failure', 2);
    assert.notEqual(failures(cold)[0].uuid, failures(cold)[1].uuid);
    assert.deepEqual(history(cold).map(m => m.type), ['user_prompt', 'turn_failure', 'user_prompt', 'turn_failure']);

    // Real warm handle.send -> adapter preparation rejects, without a result.
    control.loadError = null;
    const warm = create();
    start(warm, 'successful first prompt');
    await waitFor(() => sessions.getSession(warm.id).status === 'completed', 'initial successful turn');
    const warmHandle = runnerHandles.get(warm.id).handle;
    const resultCount = history(warm).filter(m => m.type === 'result').length;
    control.loadError = new Error('Warm send preparation failed');
    prompt(warm, 'warm failed prompt');
    warmHandle.send('warm failed prompt', undefined, 'fixture:model');
    await waitFor(() => failures(warm).length === 1, 'warm preparation rejection');
    checkFailure(warm, 'Warm send preparation failed');
    assert.equal(history(warm).filter(m => m.type === 'result').length, resultCount);
    assert.deepEqual(history(warm).slice(-2).map(m => m.type), ['user_prompt', 'turn_failure']);

    // Throw inside the fake SDK stream, not from manually synthesized events.
    // The REAL adapter must produce result -> status_change -> error in order.
    control.loadError = null;
    control.turnError = new Error('Stream transport failed');
    const streaming = create();
    const providerEvents = [];
    service.events.on('event', event => {
      if (event.threadId === streaming.id) providerEvents.push(event);
    });
    start(streaming, 'stream fails');
    await waitFor(() => failures(streaming).length === 1, 'stream failure');
    checkFailure(streaming, 'Stream transport failed');
    assert.deepEqual(providerEvents.slice(-3).map(e => e.type === 'message' ? e.message.type : e.type),
      ['result', 'status_change', 'error']);
    assert.equal(providerEvents.at(-3).message.subtype, 'error');
    assert.equal(providerEvents.at(-2).status, 'error');
    assert.deepEqual(events(streaming).slice(-5).map(e => e.type === 'stream.message' ? e.payload.message.type : e.type),
      ['result', 'session.status', 'turn_failure', 'session.status', 'runner.error']);
    assert.deepEqual(history(streaming).slice(-2).map(m => m.type), ['result', 'turn_failure']);

    // Replacement is installed by the real startRunner, not a forged map entry.
    control.turnError = null;
    const replaced = create();
    const old = start(replaced, 'old successful turn');
    await waitFor(() => sessions.getSession(replaced.id).status === 'completed', 'old turn');
    start(replaced, 'replacement successful turn');
    const beforeLate = history(replaced);
    const broadcastsBeforeLate = broadcasts.length;
    old.onError(new Error('late old handle'));
    assert.deepEqual(history(replaced), beforeLate, 'late retired handle cannot persist failure');
    assert.equal(broadcasts.length, broadcastsBeforeLate);
    assert.equal(sessions.getSession(replaced.id).status, 'running');
    await waitFor(() => sessions.getSession(replaced.id).status === 'completed', 'replacement turn');
    assert.equal(failures(replaced).length, 0);

    const expected = ids.map(id => ({ id, history: sessions.getSessionHistory(id), status: sessions.getSession(id).status }));
    fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected));
    console.log('PASS: real startRunner/agent-loop/service/adapter errors persist once, broadcast in order, and reject stale handles');
  } finally {
    await service.stopAll();
    sessions.close();
  }
}

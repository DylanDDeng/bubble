// Real Electron + SDK + SQLite. All three profiles run under a disposable test home.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const desktop = path.resolve(__dirname, '../..');

async function child() {
  const root = process.env.BUBBLE_ISOLATION_FIXTURE;
  const profile = process.env.BUBBLE_DESKTOP_PROFILE;
  const label = process.env.BUBBLE_ISOLATION_LABEL;
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  // Mock only the application home resolver, never change the user's HOME.
  os.homedir = () => home;
  app.setPath('appData', path.join(root, 'app-data'));
  app.setAppPath(desktop);
  const { desktopDataProfile: paths } = require('../../dist-electron/electron/data-environment');
  await app.whenReady();
  assert.equal(paths.profile, profile);
  assert.equal(process.env.BUBBLE_HOME, paths.agentHome);
  const store = require('../../dist-electron/electron/libs/session-store');
  const { getBubbleSdk, loadBubbleSdk, resolveBubbleHome } = require('../../dist-electron/electron/libs/provider/bubble-sdk-loader');
  const { importBubbleHistory } = require('../../dist-electron/electron/libs/bubble-history-import');
  const { getBubbleMcpServers, saveBubbleMcpServers } = require('../../dist-electron/electron/libs/bubble-mcp-settings');
  store.initialize();
  const sdk = await getBubbleSdk(root);
  assert.equal(resolveBubbleHome(), paths.agentHome);
  if (process.env.BUBBLE_ISOLATION_REOPEN === '1') {
    assert.equal(sdk.listSessions().length, 1);
    assert.equal(store.listSessions().length, 1);
    assert.equal(await importBubbleHistory(), 0);
    assert.deepEqual(Object.keys(getBubbleMcpServers()), [label]);
  } else {
    assert.equal(sdk.listSessions().length, 0, 'must not discover another profile history');
    assert.equal(store.listSessions().length, 0);
    assert.deepEqual(getBubbleMcpServers(), {});
    const { SessionManager } = await loadBubbleSdk();
    const session = SessionManager.create(root, `${label}.jsonl`);
    session.appendMessage({ role: 'user', content: `isolated ${label}` });
    assert.equal(await importBubbleHistory(), 1);
    assert.equal(store.listSessions().length, 1);
    assert.equal(sdk.listSessions().length, 1);
    assert.equal(store.listSessions()[0].bubble_session_id, label);
    saveBubbleMcpServers({ [label]: { type: 'stdio', command: 'fixture-command' } });
  }
  store.close();
  console.log(`PASS: ${label} ${process.env.BUBBLE_ISOLATION_REOPEN === '1' ? 'reopen' : 'initial'} isolated history, database and MCP`);
}

function hashes(root) {
  const result = {};
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, hashes(file));
    else result[file] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return result;
}

if (process.env.BUBBLE_ISOLATION_FIXTURE) {
  child().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-profile-runtime-'));
  const run = (profile, label = profile, reopen = false) => {
    const env = { ...process.env, BUBBLE_ISOLATION_FIXTURE: root, BUBBLE_DESKTOP_PROFILE: profile, BUBBLE_ISOLATION_LABEL: label, BUBBLE_ISOLATION_REOPEN: reopen ? '1' : '0', BUBBLE_DESKTOP_QA_ROOT: path.join(root, label) };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', timeout: 45000 });
    process.stdout.write(result.stdout || '');
    if (result.status !== 0) throw new Error(result.stderr || String(result.error || result.status));
  };
  try {
    run('production');
    const productionAgent = hashes(path.join(root, 'home/.bubble'));
    const productionDb = hashes(path.join(root, 'app-data/Bubble'));
    run('dev');
    run('dev', 'dev', true);
    const devAgent = hashes(path.join(root, 'home/.bubble-dev'));
    const devDb = hashes(path.join(root, 'app-data/Bubble Dev'));
    run('qa', 'qa-one');
    run('qa', 'qa-two');
    assert.deepEqual(hashes(path.join(root, 'home/.bubble')), productionAgent);
    assert.deepEqual(hashes(path.join(root, 'app-data/Bubble')), productionDb);
    assert.deepEqual(hashes(path.join(root, 'home/.bubble-dev')), devAgent);
    assert.deepEqual(hashes(path.join(root, 'app-data/Bubble Dev')), devDb);
    run('production', 'production', true);
    console.log('PASS: dev and QA never change production; QA never changes dev');
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}

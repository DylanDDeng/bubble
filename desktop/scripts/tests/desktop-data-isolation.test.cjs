const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDesktopDataProfile } = require('../../dist-electron/shared/desktop-data-profile');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-profile-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home: path.join(root, 'home'), appData: path.join(root, 'app-data'), root };
}

test('production, persistent dev and per-run QA have distinct desktop and agent paths', t => {
  const f = fixture(t);
  const production = resolveDesktopDataProfile({ ...f, profile: 'production' });
  const dev = resolveDesktopDataProfile({ ...f, profile: 'dev' });
  const qa = resolveDesktopDataProfile({ ...f, profile: 'qa', qaRoot: path.join(f.root, 'qa') });
  assert.equal(production.userData, path.join(f.appData, 'Bubble'));
  assert.equal(production.agentHome, path.join(f.home, '.bubble'));
  assert.equal(dev.userData, path.join(f.appData, 'Bubble Dev'));
  assert.equal(dev.agentHome, path.join(f.home, '.bubble-dev'));
  assert.equal(new Set([production, dev, qa].flatMap(x => [x.userData, x.agentHome])).size, 6);
  assert.deepEqual(resolveDesktopDataProfile({ ...f, profile: 'dev' }), dev);
});

test('legacy isolated desktop overrides also isolate the Agent home', t => {
  const f = fixture(t);
  const userData = path.join(f.root, 'old-qa');
  const qa = resolveDesktopDataProfile({ ...f, profile: 'qa', legacyUserData: userData });
  assert.equal(qa.userData, userData);
  assert.equal(qa.agentHome, path.join(userData, 'agent'));
});

test('QA rejects protected data and symlink aliases; missing/invalid profiles fail closed', t => {
  const f = fixture(t);
  for (const legacyUserData of [path.join(f.appData, 'Bubble'), path.join(f.appData, 'Bubble Dev'), path.join(f.home, '.bubble', 'qa'), f.home]) {
    assert.throws(() => resolveDesktopDataProfile({ ...f, profile: 'qa', legacyUserData }), /overlapping/);
  }
  fs.mkdirSync(path.join(f.home, '.bubble'), { recursive: true });
  fs.symlinkSync(path.join(f.home, '.bubble'), path.join(f.home, '.bubble-dev'), 'dir');
  assert.throws(() => resolveDesktopDataProfile({ ...f, profile: 'dev' }), /overlapping/);
  assert.throws(() => resolveDesktopDataProfile({ ...f, profile: 'qa' }), /QA requires/);
  assert.throws(() => resolveDesktopDataProfile({ ...f, profile: 'oops' }), /Unknown/);
});

test('launchers ignore inherited data overrides and create a fresh QA root on each launch', async t => {
  const { createDesktopLaunchEnv } = await import('../data-environment.mjs');
  const inherited = { BUBBLE_HOME: '/formal', BUBBLE_DEV: '1', BUBBLE_DESKTOP_USER_DATA: '/formal-ui', AEGIS_USER_DATA_DIR: '/old-ui', BUBBLE_DESKTOP_QA_ROOT: '/old-qa', DEV_SERVER_URL: 'http://old', BUBBLE_DESKTOP_DEV_SERVER: '1' };
  for (const profile of ['production', 'dev', 'qa']) {
    const env = createDesktopLaunchEnv(profile, inherited);
    if (env.BUBBLE_DESKTOP_QA_ROOT) t.after(() => fs.rmSync(env.BUBBLE_DESKTOP_QA_ROOT, { recursive: true, force: true }));
    assert.equal(env.BUBBLE_DESKTOP_PROFILE, profile);
    for (const key of ['BUBBLE_HOME', 'BUBBLE_DEV', 'BUBBLE_DESKTOP_USER_DATA', 'AEGIS_USER_DATA_DIR', 'DEV_SERVER_URL', 'BUBBLE_DESKTOP_DEV_SERVER']) assert.equal(env[key], undefined);
    if (profile === 'qa') {
      const another = createDesktopLaunchEnv('qa', inherited);
      t.after(() => fs.rmSync(another.BUBBLE_DESKTOP_QA_ROOT, { recursive: true, force: true }));
      assert.notEqual(env.BUBBLE_DESKTOP_QA_ROOT, another.BUBBLE_DESKTOP_QA_ROOT);
    }
  }
});

test('MCP settings resolve the active home at call time, including dev fallback', t => {
  const f = fixture(t);
  const originalHome = process.env.BUBBLE_HOME;
  const originalDev = process.env.BUBBLE_DEV;
  t.after(() => {
    if (originalHome === undefined) delete process.env.BUBBLE_HOME; else process.env.BUBBLE_HOME = originalHome;
    if (originalDev === undefined) delete process.env.BUBBLE_DEV; else process.env.BUBBLE_DEV = originalDev;
  });
  const { saveBubbleMcpServers, getBubbleMcpServers } = require('../../dist-electron/electron/libs/bubble-mcp-settings');
  const { resolveBubbleHome } = require('../../dist-electron/electron/libs/bubble-home');
  for (const profile of ['production', 'dev', 'qa']) {
    process.env.BUBBLE_HOME = path.join(f.root, profile);
    assert.deepEqual(getBubbleMcpServers(), {});
    saveBubbleMcpServers({ [profile]: { type: 'stdio', command: 'fixture-command' } });
    assert.deepEqual(Object.keys(getBubbleMcpServers()), [profile]);
  }
  delete process.env.BUBBLE_HOME;
  process.env.BUBBLE_DEV = '1';
  assert.equal(resolveBubbleHome(), path.join(os.homedir(), '.bubble-dev'));
});

test('bootstrap selects both homes before consumers and never falls back after directory failure', t => {
  const vm = require('node:vm');
  const f = fixture(t);
  const source = fs.readFileSync(path.join(__dirname, '../../dist-electron/electron/data-environment.js'), 'utf8');
  const run = (env, packaged, fail = false) => {
    const paths = [];
    const context = {
      exports: {}, process: { env }, console: { log() {} },
      require(name) {
        if (name === 'electron') return { app: { isPackaged: packaged, getPath: () => f.appData, setName() {}, setPath: (key, value) => paths.push([key, value]) } };
        if (name === 'node:os') return { homedir: () => f.home };
        if (name === 'node:fs') return { mkdirSync() { if (fail) throw new Error('unwritable'); } };
        return { resolveDesktopDataProfile };
      },
    };
    if (fail) {
      assert.throws(() => vm.runInNewContext(source, context), /unwritable/);
      assert.equal(paths.length, 0, 'no fallback userData directory');
    } else vm.runInNewContext(source, context);
    return env;
  };
  assert.equal(run({}, false).BUBBLE_HOME, path.join(f.home, '.bubble-dev'));
  assert.equal(run({}, true).BUBBLE_HOME, path.join(f.home, '.bubble'));
  const legacy = path.join(f.root, 'legacy-qa');
  assert.equal(run({ BUBBLE_DESKTOP_USER_DATA: legacy, BUBBLE_HOME: '/untrusted-shared' }, false).BUBBLE_HOME, path.join(legacy, 'agent'));
  run({}, false, true);
  const main = fs.readFileSync(path.join(__dirname, '../../dist-electron/electron/main.js'), 'utf8');
  assert(main.indexOf('require("./data-environment")') < main.indexOf('require("./ipc-handlers")'), 'profile initialization precedes imported stores');
});

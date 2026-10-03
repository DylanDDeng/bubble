const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
  const source = readFileSync(path.join(__dirname, '../../src/electron/browserManager.ts'), 'utf8');
  const ctx = vm.createContext({ exports: {}, console, setTimeout, clearTimeout, URL,
    require(name) {
      if (name === 'electron') return {};
      if (name === './util') return { normalizeExternalUrl: value => value };
      if (name === '../shared/browser-types') return { BROWSER_SESSION_PARTITION: 'qa' };
      return require(name);
    },
  });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const manager = new ctx.exports.BrowserManager();
  let attached = null;
  manager.attachActiveTab = id => { attached = id; };
  manager.detachAttachedRuntime = () => { attached = null; };
  manager.resumeSession = () => {};
  manager.scheduleSessionSuspend = () => {};
  const bounds = { x: 400, y: 80, width: 500, height: 600 };
  return { manager, attached: () => attached, bounds };
}

test('hiding A revokes its viewport; background opens cannot attach to B', () => {
  const { manager: m, attached, bounds } = fixture();
  m.setPanelBounds({ sessionId: 'a', bounds });
  m.open({ sessionId: 'a' });
  assert.equal(attached(), 'a');
  m.hide({ sessionId: 'a' });
  assert.equal(attached(), null);
  m.open({ sessionId: 'a' });
  m.open({ sessionId: 'b' });
  assert.equal(attached(), null, 'open alone must not reuse hidden bounds');
  m.setPanelBounds({ sessionId: 'a', bounds });
  assert.equal(attached(), 'a', 'returning to A restores its existing page');
});

test('bounds arriving before open belong only to the requesting session', () => {
  const { manager: m, attached, bounds } = fixture();
  m.setPanelBounds({ sessionId: 'a', bounds });
  m.open({ sessionId: 'a' });
  m.setPanelBounds({ sessionId: 'b', bounds });
  assert.equal(attached(), null, 'detach A while B initializes');
  m.open({ sessionId: 'a' });
  assert.equal(attached(), null, 'late A open cannot steal B viewport');
  m.open({ sessionId: 'b' });
  assert.equal(attached(), 'b');
  m.hide({ sessionId: 'a' });
  assert.equal(attached(), 'b', 'late A cleanup must not hide B');
});

test('unmount before open, zero bounds and close all revoke viewport ownership', () => {
  for (const operation of ['hide', 'close', 'zero']) {
    const { manager: m, attached, bounds } = fixture();
    m.setPanelBounds({ sessionId: 'a', bounds });
    if (operation === 'zero') m.setPanelBounds({ sessionId: 'a', bounds: { ...bounds, width: 0 } });
    else m[operation]({ sessionId: 'a' });
    m.open({ sessionId: 'a' });
    assert.equal(attached(), null, operation);
  }
});

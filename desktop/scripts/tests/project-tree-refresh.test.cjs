const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCoalescedRefresh } = require('../../dist-electron/electron/libs/coalesced-refresh');
const { readProjectTree, isIgnoredProjectTreeChange } = require('../../dist-electron/electron/libs/project-tree');
const { createProjectTreeReader } = require('../../dist-electron/electron/libs/project-tree-reader');

const tick = () => new Promise(resolve => setImmediate(resolve));
function controlledReader() {
  const scans = [];
  const reader = createProjectTreeReader((cwd, signal) => new Promise((resolve, reject) => {
    scans.push({ cwd, signal, resolve, reject });
  }));
  return { reader, scans };
}

test('20 initial reads of the same root share one scan; completed trees are released', async () => {
  const { reader, scans } = controlledReader();
  const calls = Array.from({ length: 20 }, () => reader.read('/tmp/project/./'));
  await tick();
  assert.equal(scans.length, 1);
  const tree = { name: 'project', path: '/tmp/project', kind: 'dir', children: [] };
  scans[0].resolve(tree);
  assert((await Promise.all(calls)).every(result => result === tree));
  const next = reader.read('/tmp/project');
  await tick();
  assert.equal(scans.length, 2, 'future requests do not receive a stale cached tree');
  scans[1].resolve(null);
  await next;
});

test('cancelling one consumer preserves others; last cancellation stops the scan', async () => {
  const { reader, scans } = controlledReader();
  const a = new AbortController();
  const b = new AbortController();
  const first = reader.read('/tmp/project', a.signal);
  const second = reader.read('/tmp/project', b.signal);
  await tick();
  a.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(scans[0].signal.aborted, false);
  b.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(scans[0].signal.aborted, true);
  const replacement = reader.read('/tmp/project');
  await tick();
  assert.equal(scans.length, 1, 'replacement waits for cancelled traversal to unwind');
  scans[0].reject(scans[0].signal.reason);
  await tick();
  assert.equal(scans.length, 2);
  scans[1].resolve(null);
  await replacement;
});

test('refresh and post-mutation reads wait for the initial scan and share one fresh scan', async () => {
  const { reader, scans } = controlledReader();
  const initial = reader.read('/tmp/project');
  await tick();
  const refreshes = Array.from({ length: 20 }, () => reader.readFresh('/tmp/project'));
  await tick();
  assert.equal(scans.length, 1);
  scans[0].resolve({ name: 'old', path: '/tmp/project', kind: 'dir', children: [] });
  await initial;
  await tick();
  assert.equal(scans.length, 2);
  const fresh = { name: 'new', path: '/tmp/project', kind: 'dir', children: [] };
  scans[1].resolve(fresh);
  assert((await Promise.all(refreshes)).every(tree => tree === fresh));
});

test('a stopped refresh waiting behind an initial read never starts another scan', async () => {
  const { reader, scans } = controlledReader();
  const initial = reader.read('/tmp/project');
  await tick();
  const controller = new AbortController();
  const fresh = reader.readFresh('/tmp/project', controller.signal);
  controller.abort();
  await assert.rejects(fresh, { name: 'AbortError' });
  scans[0].resolve(null);
  await initial;
  await tick();
  assert.equal(scans.length, 1);
});

test('failed scans can retry, and dispose aborts active filesystem work', async () => {
  const { reader, scans } = controlledReader();
  const failed = reader.read('/tmp/project');
  await tick();
  scans[0].reject(new Error('read failed'));
  await assert.rejects(failed, /read failed/);
  const retry = reader.read('/tmp/project');
  await tick();
  assert.equal(scans.length, 2);
  reader.dispose();
  assert.equal(scans[1].signal.aborted, true);
  scans[1].reject(scans[1].signal.reason);
  await assert.rejects(retry, { name: 'AbortError' });
  await assert.rejects(reader.read('/tmp/project'), /closed/);
});

test('a slow scan coalesces repeated changes into one trailing scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scans = [];
  const errors = [];
  const refresh = createCoalescedRefresh(signal => new Promise(resolve => scans.push({ signal, resolve })), 200, e => errors.push(e));
  t.after(() => refresh.stop());
  refresh.schedule();
  t.mock.timers.tick(200);
  assert.equal(scans.length, 1);
  for (let i = 0; i < 1000; i++) {
    refresh.schedule();
    t.mock.timers.tick(200);
  }
  assert.equal(scans.length, 1, 'no overlapping scans even under sustained events');
  scans[0].resolve();
  await Promise.resolve();
  t.mock.timers.tick(200);
  assert.equal(scans.length, 2, 'exactly one trailing scan');
  refresh.schedule();
  refresh.stop();
  assert.equal(scans[1].signal.aborted, true);
  scans[1].resolve();
  await Promise.resolve();
  refresh.schedule();
  t.mock.timers.tick(1000);
  assert.equal(scans.length, 2, 'closed watchers cannot start another scan');
  assert.deepEqual(errors, []);
});

test('stopping before debounce fires cancels the pending scan', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const refresh = createCoalescedRefresh(async () => { calls++; }, 200, assert.fail);
  refresh.schedule();
  refresh.stop();
  t.mock.timers.tick(1000);
  assert.equal(calls, 0);
});

test('scan failure reports once and later changes can retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const errors = [];
  const refresh = createCoalescedRefresh(async () => { calls++; throw new Error('read failed'); }, 200, e => errors.push(e));
  t.after(() => refresh.stop());
  for (let i = 0; i < 2; i++) {
    refresh.schedule();
    t.mock.timers.tick(200);
    await Promise.resolve();
  }
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
});

test('tree ignores build output and aborts filesystem traversal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bubble-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['src', 'node_modules', '.dev-sdk-build', 'dist-react']) {
    await fs.mkdir(path.join(root, dir));
    await fs.writeFile(path.join(root, dir, 'entry.js'), '');
  }
  const tree = await readProjectTree(root);
  assert.deepEqual(tree.children.map(node => node.name), ['src']);
  assert.equal(tree.children[0].children[0].name, 'entry.js');
  assert.equal(isIgnoredProjectTreeChange('desktop/node_modules/pkg/main.js'), true);
  assert.equal(isIgnoredProjectTreeChange(path.join('desktop', '.dev-sdk-build', 'main.js')), true);
  assert.equal(isIgnoredProjectTreeChange('src/building.ts'), false);
  const controller = new AbortController();
  const reading = readProjectTree(root, controller.signal);
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  await assert.rejects(readProjectTree(root, controller.signal), { name: 'AbortError' });
});

test('visible files named build/dist/node_modules still refresh on create and delete', async t => {
  const { watch } = require('node:fs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bubble-tree-leaf-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['build', 'dist', 'node_modules']) {
    assert.equal(isIgnoredProjectTreeChange(name), false);
    assert.equal(isIgnoredProjectTreeChange(path.join('src', name)), false);
    assert.equal(isIgnoredProjectTreeChange(path.join(name, 'internal.js')), true);
    await fs.writeFile(path.join(root, name), 'visible');
  }
  const before = await readProjectTree(root);
  assert.deepEqual(before.children.map(node => node.name).sort(), ['build', 'dist', 'node_modules']);
  const deletion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No delete event received')), 3000);
    t.after(() => clearTimeout(timer));
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename?.toString() === 'build') {
        clearTimeout(timer);
        resolve(filename.toString());
      }
    });
    t.after(() => watcher.close());
  });
  await fs.unlink(path.join(root, 'build'));
  assert.equal(isIgnoredProjectTreeChange(await deletion), false);
  const after = await readProjectTree(root);
  assert(!after.children.some(node => node.name === 'build'));
  if (path.sep === '/') {
    assert.equal(isIgnoredProjectTreeChange('literal\\build\\name'), false, 'backslash is a valid POSIX filename character');
  }
});

test('actual initial-read IPC handlers share scans and scope cancellation to the sender', async () => {
  const vm = require('node:vm');
  const ts = require('typescript');
  const { EventEmitter } = require('node:events');
  const source = await fs.readFile(path.join(__dirname, '../../src/electron/ipc-handlers.ts'), 'utf8');
  const block = source.slice(source.indexOf('// RPC: 获取项目文件树'), source.indexOf("ipcMainHandle('create-project-attachment'"));
  const { reader, scans } = controlledReader();
  const handlers = new Map();
  const requests = new Map();
  vm.runInNewContext(ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMainHandle: (name, handler) => handlers.set(name, handler),
    readProjectTree: reader.read,
    projectTreeRequests: requests,
    AbortController,
    uuidv4: require('node:crypto').randomUUID,
  });
  const senderA = Object.assign(new EventEmitter(), { id: 1 });
  const senderB = Object.assign(new EventEmitter(), { id: 2 });
  const get = handlers.get('get-project-tree');
  const cancel = handlers.get('cancel-project-tree-read');
  const calls = Array.from({ length: 20 }, (_, i) => get({ sender: senderA }, '/tmp/project', `request-${i}`));
  const otherWindow = get({ sender: senderB }, '/tmp/project', 'request-0');
  await tick();
  assert.equal(scans.length, 1);
  for (let i = 0; i < 20; i++) cancel({ sender: senderA }, `request-${i}`);
  assert((await Promise.all(calls)).every(tree => tree === null));
  assert.equal(scans[0].signal.aborted, false, 'other window still owns this scan');
  senderB.emit('destroyed');
  assert.equal(await otherWindow, null);
  assert.equal(scans[0].signal.aborted, true);
  scans[0].reject(scans[0].signal.reason);
  await tick();
  assert.equal(requests.size, 0);
  assert.equal(senderA.listenerCount('destroyed'), 0);
  assert.equal(senderB.listenerCount('destroyed'), 0);
});

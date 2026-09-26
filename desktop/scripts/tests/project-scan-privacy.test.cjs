const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const policy = require('../../dist-electron/electron/libs/project-scan-policy');
const { readProjectTree } = require('../../dist-electron/electron/libs/project-tree');

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bubble-privacy-'));
  const home = await fs.realpath(tmp);
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  for (const dir of ['project/src', 'project/Library', 'project/Music', 'Library/Containers/com.apple.Music', 'Library/Reminders', 'Music', 'Pictures', 'Documents']) {
    await fs.mkdir(path.join(home, dir), { recursive: true });
    await fs.writeFile(path.join(home, dir, 'sample.png'), 'fake');
  }
  return { home, project, options: { home, platform: 'darwin' } };
}
function record(t) {
  const calls = [];
  for (const method of ['lstat', 'stat', 'readdir', 'readlink', 'realpath', 'readFile']) {
    const original = fs[method];
    t.mock.method(fs, method, async (...args) => { calls.push([method, String(args[0])]); return original(...args); });
  }
  return calls;
}
test('broad and private roots are refused before any filesystem access', async t => {
  const { home, options } = await fixture(t);
  const calls = record(t);
  for (const root of ['/', home, path.dirname(home), '/Users', '/Users/other', '/Applications', '/Volumes/Disk', '/System/Volumes/Data/Users/other/Library', ...['Library', 'Music', 'Pictures', 'Documents'].map(p => path.join(home, p))]) {
    const tree = await readProjectTree(root, undefined, options);
    assert.equal(tree.scanNotice, policy.PROJECT_SCAN_NOTICE, root);
    assert.deepEqual(tree.children, []);
  }
  assert.deepEqual(calls, []);
});
test('safe projects and aliases work, private links never reach target metadata or content', async t => {
  const { home, project, options } = await fixture(t);
  const alias = path.join(home, 'alias');
  await fs.symlink(project, alias);
  await fs.symlink(path.join(home, 'Library'), path.join(project, 'app-link'));
  await fs.symlink(home, path.join(project, 'home-link'));
  await fs.mkdir(path.join(project, 'Hidden.app'));
  await fs.writeFile(path.join(project, 'Hidden.app/secret'), 'hidden');
  const calls = record(t);
  const tree = await readProjectTree(alias, undefined, options);
  assert.equal(tree.kind, 'dir');
  assert(tree.children.some(n => n.name === 'src' && n.children[0].path === path.join(alias, 'src/sample.png')));
  assert(tree.children.some(n => n.name === 'Library' && n.children.length));
  assert(tree.children.some(n => n.name === 'Music' && n.children.length));
  assert(!tree.children.some(n => n.name === 'Hidden.app'));
  assert.equal(await policy.resolvePassiveProjectPath(path.join(project, 'app-link/Containers/com.apple.Music/sample.png'), options), null);
  assert.equal((await readProjectTree(path.join(project, 'app-link'), undefined, options)).scanNotice, policy.PROJECT_SCAN_NOTICE);
  assert.equal((await readProjectTree(path.join(project, 'home-link'), undefined, options)).scanNotice, policy.PROJECT_SCAN_NOTICE);
  assert(!calls.some(([, p]) => policy.isPrivateProjectPath(p, options)), JSON.stringify(calls));
  assert(!calls.some(([method, p]) => method === 'readdir' && p === home));
});
test('missing directories remain missing and cancellation is propagated', async t => {
  const { project, options } = await fixture(t);
  assert.equal(await readProjectTree(path.join(project, 'missing'), undefined, options), null);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readProjectTree(project, controller.signal, options), { name: 'AbortError' });
});
test('actual watcher IPC refuses blocked roots before accessibility probes or subscriptions', async t => {
  const { home, project, options } = await fixture(t);
  const source = await fs.readFile(path.join(__dirname, '../../src/electron/ipc-handlers.ts'), 'utf8');
  const block = source.slice(source.indexOf("ipcMainHandle('watch-project-tree'"), source.indexOf('// RPC: 取消订阅项目文件树更新'));
  const handlers = new Map(); const accesses = []; const closed = [];
  vm.runInNewContext(ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMainHandle: (n, h) => handlers.set(n, h), resolveProjectScanRoot: p => policy.resolveProjectScanRoot(p, options),
    isReadableDirectory: async p => { accesses.push(p); return true; }, closeProjectTreeWatcher: p => closed.push(p),
    projectWatchers: new Map(), watch: p => { accesses.push(p); return {}; }, createCoalescedRefresh: () => ({}),
    scheduleProjectTree: () => {}, PROJECT_TREE_REFRESH_DELAY_MS: 200, console,
  });
  const watch = handlers.get('watch-project-tree');
  assert.equal(await watch({}, home), false);
  assert.equal(await watch({}, path.join(home, 'Library')), false);
  assert.deepEqual(accesses, []);
  assert.equal(closed.length, 2);
  assert.equal(await watch({}, project), true);
  assert.deepEqual(accesses, [project, project]);
});
test('actual preview IPC blocks private paths and aliases before validation/read; normal and missing files still work', async t => {
  const { home, project, options } = await fixture(t);
  await fs.symlink(path.join(home, 'Music'), path.join(project, 'media'));
  const source = await fs.readFile(path.join(__dirname, '../../src/electron/ipc-handlers.ts'), 'utf8');
  const start = source.indexOf("  ipcMainHandle(\n    'read-project-file-preview'");
  const end = source.indexOf("      const validation = await validateProjectFilePath", start);
  const block = source.slice(start, end) + "return {kind:'allowed'}; });";
  let handler;
  vm.runInNewContext(ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMainHandle: (_, h) => { handler = h; }, ...path,
    resolvePassiveProjectPath: p => policy.resolvePassiveProjectPath(p, options),
  });
  const calls = record(t);
  for (const p of [path.join(home, 'Music/sample.png'), path.join(project, 'media/sample.png')]) {
    assert.equal((await handler({}, project, p)).kind, 'error');
    assert.equal((await handler({}, project, p, {passive:false})).kind, 'error', 'no renderer bypass');
  }
  assert(!calls.some(([, p]) => policy.isPrivateProjectPath(p, options)));
  assert.equal((await handler({}, project, 'src/sample.png')).kind, 'allowed');
  assert.equal((await handler({}, project, 'missing.png')).message, 'File not found');
});

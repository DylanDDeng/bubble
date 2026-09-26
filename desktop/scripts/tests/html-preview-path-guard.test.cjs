const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');

test('preview containment returns a structured rejection for outside paths and symlinks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bubble-html-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  const inside = path.join(project, 'index.html'), outside = path.join(dir, 'outside.html');
  await fs.writeFile(inside, '<html>inside</html>');
  await fs.writeFile(outside, '<html>outside</html>');
  const link = path.join(project, 'link.html'); await fs.symlink(outside, link);
  const source = await fs.readFile(path.join(__dirname, '../../src/electron/ipc-handlers.ts'), 'utf8');
  const tree = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['isPathWithinRoot', 'validateProjectFilePath', 'getHtmlPreviewUrl']);
  const actual = tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(tree)).join('\n');
  assert.equal(tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).length, 3);
  let served = 0;
  const ctx = vm.createContext({ ...path, fsPromises: fs, getLocalPreviewUrl: async () => { served++; return { ok: true, url: 'http://127.0.0.1/fixture' }; } });
  vm.runInContext(ts.transpileModule(actual, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  for (const file of [outside, '../outside.html', link]) {
    const result = await ctx.getHtmlPreviewUrl(project, file);
    assert.equal(result.ok, false); assert.equal(result.code, 'outside_project');
  }
  assert.equal(served, 0, 'rejected files never reach the preview server');
  assert.equal((await ctx.getHtmlPreviewUrl(project, inside)).ok, true);
  assert.equal((await ctx.getHtmlPreviewUrl(project, 'index.html')).ok, true);
  assert.equal(served, 2);
});

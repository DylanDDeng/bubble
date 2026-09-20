const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-packaged-native-'));
app.setPath('userData', home);
process.env.BUBBLE_HOME = path.join(home, 'agent');
const root = process.env.BUBBLE_PACKAGE_APP_PATH;
assert(root, 'This check must use the packaged application');
const packageRequire = createRequire(path.join(root, 'package.json'));
let terminal;
app.whenReady().then(async () => {
  const naming = packageRequire('./dist-electron/electron/libs/util.js');
  assert.equal(await naming.generateWorktreeBranchSlug({ prompt: 'Test task' }), null);
  assert(await naming.generateSessionTitle('Test task'), 'title generation must work without another agent SDK');
  const { getQuickJS } = packageRequire('quickjs-emscripten');
  const vm = (await getQuickJS()).newContext();
  const result = vm.evalCode('21 * 2');
  assert(!result.error, 'packaged workflow WASM must execute');
  assert.equal(vm.dump(result.value), 42);
  result.value.dispose(); vm.dispose();

  const typescript = packageRequire('typescript');
  const defaultLib = typescript.getDefaultLibFilePath({ target: typescript.ScriptTarget.ES2023 });
  assert(fs.existsSync(defaultLib), 'TypeScript standard library must remain in package');

  const pty = packageRequire('node-pty');
  await new Promise((resolve, reject) => {
    let output = '';
    terminal = pty.spawn('/bin/sh', ['-c', 'printf bubble-pty-ok'], { cwd: home, env: { ...process.env } });
    const timer = setTimeout(() => { terminal.kill(); reject(new Error('Packaged PTY timed out')); }, 5000);
    terminal.onData(chunk => { output += chunk; });
    terminal.onExit(event => {
      clearTimeout(timer);
      try { assert.equal(event.exitCode, 0); assert.match(output, /bubble-pty-ok/); resolve(); }
      catch (error) { reject(error); }
    });
  });
  console.log('PASS: packaged PTY spawn helper, workflow QuickJS/WASM and TypeScript standard library.');
}).then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  try { terminal?.kill(); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(code);
}

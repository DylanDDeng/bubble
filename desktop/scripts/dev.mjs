import { spawn } from 'node:child_process';
import { watch, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createDesktopLaunchEnv } from './data-environment.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const sdkBuild = resolve(desktop, '.dev-sdk-build');
const launchEnv = createDesktopLaunchEnv(process.argv.includes('--qa') ? 'qa' : 'dev');
const children = new Set();
const watchers = [];
let server;
let electron;
let stopping = false;
let rebuilding = false;
let debounce;
const dirty = new Set();
const log = (message) => console.log(`[desktop:dev] ${message}`);

function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: desktop, stdio: 'inherit', detached: process.platform !== 'win32', ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', () => children.delete(child));
  return child;
}

function run(script, args = [], cwd = desktop) {
  return new Promise((resolveRun, reject) => {
    if (stopping) return reject(new Error('Development session stopped'));
    const child = launch(process.execPath, [script, ...args], { cwd });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Build exited with ${signal || code}`)));
  });
}

function signalTree(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveStop => {
    const timeout = setTimeout(() => signalTree(child, 'SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      signalTree(child, 'SIGTERM'); // Clean up stragglers after the host has flushed state.
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  await Promise.allSettled([server?.close(), ...[...children].map(stopChild)]);
  process.exitCode = code;
  log('Stopped Electron, Vite and build watchers.');
}

function startElectron() {
  const env = { ...launchEnv, BUBBLE_DESKTOP_DEV_SERVER: '1', DEV_SERVER_URL: server.resolvedUrls.local[0] };
  delete env.ELECTRON_RUN_AS_NODE;
  // An alternate binary lets isolated native QA avoid the user's Electron app.
  const binary = process.env.BUBBLE_DESKTOP_ELECTRON || resolve(desktop, 'node_modules/.bin/electron');
  const child = launch(binary, [desktop], { env });
  electron = child;
  child.once('error', error => { console.error(error); void shutdown(1); });
  child.once('exit', code => {
    if (electron === child && !stopping) void shutdown(code ?? 1);
  });
  log(`Electron started (PID ${child.pid}). UI hot reload is ready.`);
}

async function compileSdk() {
  const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
  await run(tsc, ['-p', 'packages/pi-tui/tsconfig.build.json', '--noEmitOnError'], root);
  await rm(sdkBuild, { recursive: true, force: true });
  await run(tsc, ['-p', 'tsconfig.json', '--outDir', sdkBuild, '--noEmitOnError'], root);
}

async function compileHost() {
  await run(resolve(desktop, 'node_modules/typescript/bin/tsc'), ['-p', 'src/electron/tsconfig.json', '--noEmitOnError']);
}

async function syncSdk() {
  await run(resolve(desktop, 'scripts/sync-bubble-sdk.mjs'), [sdkBuild]);
}

async function rebuild() {
  if (stopping || rebuilding || dirty.size === 0) return;
  rebuilding = true;
  const changes = new Set(dirty);
  dirty.clear();
  try {
    log(`Rebuilding ${[...changes].join(' + ')}…`);
    if (changes.has('SDK')) await compileSdk();
    if (changes.has('Electron')) await compileHost();
    if (!stopping) {
      const previous = electron;
      electron = null; // Intentional restart must not end the whole dev session.
      await stopChild(previous);
      if (changes.has('SDK')) await syncSdk();
      if (!stopping) startElectron();
    }
  } catch (error) {
    if (!stopping) console.error('[desktop:dev] Build failed; fix the source and save to retry.', error.message);
  } finally {
    rebuilding = false;
    if (!stopping && dirty.size) debounce = setTimeout(rebuild, 250);
  }
}

function observe(path, kind, recursive = true) {
  let contents = recursive ? null : readFileSync(path, 'utf8');
  let modified = recursive ? null : statSync(path).mtimeMs;
  watchers.push(watch(path, { recursive }, (event, file) => {
    // macOS can report file metadata events on reads. Do not rebuild forever
    // when the compiler or SDK reads package.json / tsconfig.json.
    if (!recursive) {
      try {
        const nextModified = statSync(path).mtimeMs;
        if (nextModified === modified) return;
        modified = nextModified;
        const nextContents = readFileSync(path, 'utf8');
        if (nextContents === contents) return;
        contents = nextContents;
      } catch { return; }
    }
    log(`${kind} source changed: ${path}/${file || ''} (${event})`);
    dirty.add(kind);
    clearTimeout(debounce);
    debounce = setTimeout(rebuild, 250);
  }));
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  // Bind first: a port conflict must fail without opening an unrelated server.
  server = await createServer({ root: desktop, configFile: resolve(desktop, 'vite.config.ts') });
  await server.listen();
  if (!stopping) {
    server.printUrls();
    log('Compiling the local SDK and Electron host (no renderer production build or packaging).');
    rebuilding = true;
    observe(resolve(root, 'src'), 'SDK');
    observe(resolve(root, 'packages/pi-tui/src'), 'SDK');
    observe(resolve(root, 'tsconfig.json'), 'SDK', false);
    observe(resolve(root, 'package.json'), 'SDK', false);
    observe(resolve(desktop, 'src/electron'), 'Electron');
    observe(resolve(desktop, 'src/shared'), 'Electron');
    await compileSdk();
    await compileHost();
    await syncSdk();
    if (!stopping) startElectron();
    rebuilding = false;
    if (dirty.size) void rebuild();
  } else await server.close();
} catch (error) {
  if (!stopping) console.error('[desktop:dev]', error.message);
  await shutdown(1);
}

import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopLaunchEnv } from './data-environment.mjs';
import { verifyPackagedWindow } from './verify-packaged-window.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] || join(desktop, 'out/dogfood', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Bubble.app'));
await access(source);
const isolated = await mkdtemp(join(tmpdir(), 'bubble-package-check-'));
const app = join(isolated, 'Bubble.app');
const env = createDesktopLaunchEnv('qa');

async function run(command, args, extraEnv = {}) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: isolated,
      stdio: 'inherit',
      env: { ...env, ...extraEnv },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Packaged runtime check failed: ${signal || code}`)));
  });
}

try {
  // Run outside the checkout so missing dependencies cannot fall back to its node_modules.
  await run('/bin/cp', ['-R', source, app]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await verifyPackagedWindow(app, env, isolated);
  await run(join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [
    join(desktop, 'scripts/tests/bubble-packaged-native.cjs'),
  ], { BUBBLE_PACKAGE_APP_PATH: join(app, 'Contents/Resources/app.asar') });
  await run(join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [
    join(desktop, 'scripts/tests/bubble-desktop-runtime.cjs'),
  ], { BUBBLE_PACKAGE_APP_PATH: join(app, 'Contents/Resources/app.asar') });
  console.log('PASS: signed local package runs its bundled Agent outside the checkout with isolated data.');
} finally {
  await rm(isolated, { recursive: true, force: true });
  await rm(env.BUBBLE_DESKTOP_QA_ROOT, { recursive: true, force: true });
}

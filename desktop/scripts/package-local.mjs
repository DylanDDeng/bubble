import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('This local package target currently supports macOS only.');

async function run(script, args = []) {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(desktop, script), ...args], {
      cwd: desktop,
      stdio: 'inherit',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Packaging step failed: ${signal || code}`)));
  });
}

// Prepare native SQLite/PTY bindings for the exact Electron version being shipped.
await run('scripts/prepare-electron-native-deps.mjs');
await run('node_modules/electron-builder/out/cli/cli.js', [
  '--config', 'electron-builder.local.cjs', '--mac', '--' + process.arch, '--publish', 'never',
]);
await run('scripts/audit-local-package.mjs');
await run('scripts/verify-local-package.mjs');
console.log('Local Bubble app and DMG created in desktop/out/dogfood. Nothing was published.');

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
for (const args of [
  ['run', 'typecheck'],
  ['run', 'transpile:electron'],
  ['exec', '--', 'tsx', 'scripts/tests/bubble-context.test.ts'],
  ['exec', '--', 'tsx', 'scripts/tests/bubble-context-notification.test.ts'],
  ['exec', '--', 'tsx', 'scripts/tests/bubble-context-store.test.ts'],
]) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// This test owns temporary Electron userData, BUBBLE_HOME, and a random-port Vite server.
const result = spawnSync(process.execPath, ['scripts/tests/bubble-context-electron.test.mjs'], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

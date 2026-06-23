// Waits for the Vite dev server, then launches Electron pointing at it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
// The `electron` package's main export is the path to the binary.
const electronPath = require('electron');

const VITE_URL = process.env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${process.env.PORT || 10090}`;

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.status < 500) return true;
    } catch {
      // server not up yet
    }
    await sleep(300);
  }
  return false;
}

console.log(`[launch-electron] waiting for ${VITE_URL} …`);
const ok = await waitForServer(VITE_URL);
if (!ok) {
  console.error(`[launch-electron] dev server never became ready at ${VITE_URL}`);
  process.exit(1);
}

console.log('[launch-electron] starting Electron');
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: VITE_URL },
});
child.on('close', (code) => process.exit(code ?? 0));

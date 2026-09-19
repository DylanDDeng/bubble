import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDesktopLaunchEnv } from './data-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(resolve(root, 'dist-electron/electron/main.js')) ||
    !existsSync(resolve(root, 'dist-react/index.html'))) {
  throw new Error('Build the desktop first: npm run desktop:build');
}
const env = createDesktopLaunchEnv('production');
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolve(root, 'node_modules/.bin/electron'), ['.', ...process.argv.slice(2)], {
  cwd: root, env, stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

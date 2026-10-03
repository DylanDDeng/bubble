import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const runtime = resolve(desktop, 'runtime/bubble');
await mkdir(runtime, { recursive: true });
// Snapshot this checkout's build. Dependencies resolve in desktop/node_modules,
// so Electron native modules never replace the CLI's Node-native modules.
await rm(resolve(runtime, 'dist'), { recursive: true, force: true });
await cp(process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'dist'), resolve(runtime, 'dist'), { recursive: true });
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await writeFile(resolve(runtime, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, type: 'module', exports: pkg.exports,
}, null, 2));
console.log(`Desktop uses local Bubble SDK ${pkg.version}`);

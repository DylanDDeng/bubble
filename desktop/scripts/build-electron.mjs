// Bundles the Electron main + preload with esbuild.
// The Bubble core (@bubblebrain-ai/bubble) and native modules are kept EXTERNAL
// so we never bundle the TUI/FFI layer and native addons load at runtime.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

const external = ['electron', '@bubblebrain-ai/bubble', 'better-sqlite3'];

/** @type {import('esbuild').BuildOptions} */
const mainOptions = {
  entryPoints: [resolve(root, 'src/electron/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: resolve(root, 'dist-electron/main.js'),
  external,
  sourcemap: true,
  logLevel: 'info',
  // Keep ESM dynamic import + import.meta intact.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
};

/** @type {import('esbuild').BuildOptions} */
const preloadOptions = {
  entryPoints: [resolve(root, 'src/electron/preload.cts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: resolve(root, 'dist-electron/preload.cjs'),
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const [mainCtx, preloadCtx] = await Promise.all([context(mainOptions), context(preloadOptions)]);
  await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
  console.log('[build-electron] watching main + preload…');
} else {
  await Promise.all([build(mainOptions), build(preloadOptions)]);
  console.log('[build-electron] built main + preload');
}

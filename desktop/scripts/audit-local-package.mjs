import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stat, readdir, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(process.argv[2] || join(desktop, 'out/dogfood', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Bubble.app'));
const archive = join(app, 'Contents/Resources/app.asar');
const entries = [];
function visit(node, prefix = '') {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const file = prefix ? `${prefix}/${name}` : name;
    if (entry.files) visit(entry, file);
    else entries.push({ file, size: entry.size || 0, unpacked: !!entry.unpacked });
  }
}
visit(asar.getRawHeader(archive).header);
const files = new Set(entries.map(entry => entry.file));
const legacyAgents = ['@anthropic-ai/claude-agent-sdk', '@deepseek-ai/', '@earendil-works/', '@opencode-ai/', '@qoder-ai/'];
for (const entry of entries) {
  assert(!legacyAgents.some(name => entry.file.includes(`node_modules/${name}`)), `Unexpected legacy agent dependency: ${entry.file}`);
  const native = entry.file.match(/node_modules\/(?:better-sqlite3|node-pty)\/prebuilds\/([^/]+)/);
  if (native) assert.equal(native[1].replace(/\.node$/, ''), `darwin-${process.arch}`, `Foreign native binary: ${entry.file}`);
  const tuiNative = entry.file.match(/node_modules\/@bubblebrain-ai\/pi-tui\/native\/([^/]+)\/prebuilds\/([^/]+)/);
  if (tuiNative) {
    assert.equal(tuiNative[1], 'darwin');
    assert.equal(tuiNative[2], `darwin-${process.arch}`, `Foreign TUI binary: ${entry.file}`);
  }
  assert(!/node_modules\/better-sqlite3\/(src|deps)\//.test(entry.file), `SQLite build sources shipped: ${entry.file}`);
}
for (const file of [
  'runtime/bubble/dist/sdk/index.js', 'dist-react/index.html', 'dist-electron/electron/main.js',
  'node_modules/typescript/lib/tsserver.js', 'node_modules/typescript/lib/lib.es2023.d.ts',
  `node_modules/better-sqlite3/prebuilds/darwin-${process.arch}.node`,
  'node_modules/quickjs-emscripten/package.json',
]) assert(files.has(file), `Missing Bubble runtime dependency: ${file}`);
assert(entries.some(entry => /node_modules\/node-pty\/.*spawn-helper$/.test(entry.file)), 'Missing PTY spawn helper');

async function size(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  return (await Promise.all((await readdir(path)).map(name => size(join(path, name))))).reduce((a, b) => a + b, 0);
}
const report = {
  app, architecture: process.arch,
  appBytes: await size(app),
  frameworkBytes: await size(join(app, 'Contents/Frameworks')),
  archiveBytes: (await stat(archive)).size,
  nativeBytes: await size(join(app, 'Contents/Resources/app.asar.unpacked')),
};
assert(report.appBytes < 650_000_000, `Package exceeds the 650 MB size budget: ${report.appBytes}`);
const reportPath = join(dirname(dirname(app)), 'package-size-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`PASS: package contents, target binaries and size budget (${(report.appBytes / 1e6).toFixed(1)} MB). Report: ${reportPath}`);

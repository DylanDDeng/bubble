// Run the actual compiled preload in a VM, without a browser or user data.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const callbacks = new Map();
const jobs = [];
const writes = [];
let api;
const ipcRenderer = {
 on() {}, removeListener() {},
 send(channel, ...args) { writes.push({channel, args}); },
 sendSync(channel, ...args) {
  if (channel === 'renderer-state:get-all-sync') return {};
  writes.push({channel, args}); return true;
 },
};
const source = readFileSync(require('node:path').resolve(__dirname, '../../dist-electron/electron/preload.cjs'), 'utf8');
vm.runInNewContext(source, {
 exports: {}, require(name) { assert.equal(name, 'electron'); return {ipcRenderer, contextBridge: {exposeInMainWorld(_, value) {api=value;}}, webUtils: {}}; },
 window: {addEventListener(name, fn) {callbacks.set(name,fn);}},
 queueMicrotask(fn) {jobs.push(fn);}, console,
});
const storage=api.rendererState;
const body='x'.repeat(800_000);
for (let i=0;i<2262;i++) storage.setItem('board', body+i);
assert.equal(storage.getItem('board'),body+2261, 'read your writes before flushing');
assert.equal(writes.length,0);
assert.equal(jobs.length,1,'one pending flush, not one retained callback per snapshot');
jobs.shift()();
assert.equal(writes.length,1,'thousands of full snapshots cross IPC only once');
assert.equal(writes[0].channel,'renderer-state:batch');
assert.equal(writes[0].args[0].length,1);
assert.equal(writes[0].args[0][0][1],body+2261);
assert(JSON.stringify(writes).length<810_000,'bounded traffic, instead of 1.8 GB of snapshots');
writes.length=0;
storage.setItem('board',body+2261);
assert.equal(jobs.length,0,'unchanged snapshots are not transmitted');
storage.setItem('draft','saved');storage.removeItem('board');
callbacks.get('beforeunload')();
assert.equal(writes.length,1);
assert.equal(writes[0].channel,'renderer-state:batch-sync');
assert.equal(storage.getItem('board'),null);
assert.deepEqual(JSON.parse(JSON.stringify(writes[0].args[0])),[['draft','saved'],['board',null]]);
jobs.shift()();assert.equal(writes.length,1,'queued flush after unload is empty');
console.log('PASS: bounded state IPC, immediate reads, deduplication, remove and unload durability');

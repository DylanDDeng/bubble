import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { installRendererRecovery } from '../../src/electron/libs/renderer-recovery';
import { sendRendererEvent } from '../../src/electron/libs/renderer-event-delivery';
import type { ServerEvent } from '../../src/shared/types';

const dir = mkdtempSync(join(tmpdir(), 'bubble-renderer-recovery-unit-'));
const delay = () => new Promise(resolve => setTimeout(resolve, 15));
function fixture() {
  const contents = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, reload: () => { reloads++; } });
  let reloads = 0, offers = 0, quitting = false, timestamp = Date.now(), retry = false, destroyed = false;
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed });
  installRendererRecovery(win as unknown as BrowserWindow, {
    isQuitting: () => quitting, logDirectory: dir, now: () => timestamp, retryDelayMs: 1,
    offerRetry: async () => { offers++; return retry; },
    sampleMemory: () => ({ workingSetKB: 100, peakWorkingSetKB: 200 }),
  });
  return {
    crash: (reason = 'crashed') => contents.emit('render-process-gone', {}, { reason, exitCode: 5, secret: 'never-log-me' }),
    loaded: () => contents.emit('did-finish-load'),
    close: () => { destroyed = true; win.emit('closed'); },
    quit: () => { quitting = true; },
    advance: () => { timestamp += 300_001; },
    allowRetry: () => { retry = true; },
    stats: () => ({ reloads, offers }),
  };
}
async function main() {
try {
  let sends = 0, crashed = true;
  const deliveryWindow = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isCrashed: () => crashed, send: () => { sends++; throw Error('frame disposed'); } },
  } as unknown as BrowserWindow;
  const event = { type: 'session.status', payload: { sessionId: 'qa', status: 'running' } } as ServerEvent;
  sendRendererEvent(deliveryWindow, event);
  assert.equal(sends, 0, 'dead renderers do not receive stream traffic');
  crashed = false;
  assert.doesNotThrow(() => sendRendererEvent(deliveryWindow, event), 'frame disposal never throws into the provider');
  assert.equal(sends, 1);
  const f = fixture();
  f.loaded(); f.crash(); await delay();
  assert.deepEqual(f.stats(), { reloads: 1, offers: 0 });
  // A successful page load must not reset the crash-loop budget.
  f.loaded(); f.crash('oom'); await delay();
  f.loaded(); f.crash(); await delay();
  assert.deepEqual(f.stats(), { reloads: 2, offers: 1 });
  f.allowRetry(); f.crash(); await delay(); await delay();
  assert.deepEqual(f.stats(), { reloads: 3, offers: 2 });
  f.advance(); f.crash(); await delay();
  assert.deepEqual(f.stats(), { reloads: 4, offers: 2 });
  f.crash('clean-exit'); await delay();
  assert.equal(f.stats().reloads, 4);
  f.close();
  const closing = fixture(); closing.crash(); closing.close(); await delay();
  assert.equal(closing.stats().reloads, 0, 'closing cancels pending reload');
  const quitting = fixture(); quitting.crash(); quitting.quit(); await delay();
  assert.equal(quitting.stats().reloads, 0, 'quit during backoff never resurrects a renderer');
  quitting.crash(); assert.equal(quitting.stats().offers, 0); quitting.close();
  const file = join(dir, 'renderer-recovery.jsonl');
  const logs = readFileSync(file, 'utf8');
  assert(!logs.includes('never-log-me'), 'logs use an allowlist');
  assert(logs.includes('workingSetKB') && logs.includes('"reason":"oom"'));
  writeFileSync(file, 'x'.repeat(1_048_576));
  const rotating = fixture(); rotating.crash(); rotating.close();
  assert.equal(statSync(`${file}.previous`).size, 1_048_576);
  assert(statSync(file).size < 1000, 'diagnostics rotate instead of growing indefinitely');
  console.log('PASS renderer recovery: retry budget, native retry, close/quit guards, bounded sanitized diagnostics');
} finally { rmSync(dir, { recursive: true, force: true }); }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });

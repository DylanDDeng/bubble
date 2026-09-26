import type { BrowserWindow } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RendererRecoveryOptions {
  isQuitting: () => boolean;
  logDirectory: string;
  /** Native UI still works when the renderer has crashed. Never quits the host. */
  offerRetry: () => Promise<boolean>;
  sampleMemory?: () => { workingSetKB: number; peakWorkingSetKB: number } | undefined;
  now?: () => number;
  retryDelayMs?: number;
}

const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_AUTOMATIC_RELOADS = 2;
const MAX_LOG_BYTES = 1_048_576;

/** Reload the same WebContents only; runners and their subscriptions live in the host. */
export function installRendererRecovery(win: BrowserWindow, options: RendererRecoveryOptions): void {
  const contents = win.webContents;
  const now = options.now ?? Date.now;
  let crashes: number[] = [];
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let offeringRetry = false;
  let disposed = false;
  let samples: Array<{ at: number; workingSetKB: number; peakWorkingSetKB: number }> = [];
  const unavailable = () => disposed || options.isQuitting() || win.isDestroyed() || contents.isDestroyed();

  function record(event: string, details: Record<string, unknown> = {}): void {
    // Intentionally exclude URLs, prompts, provider payloads and credentials.
    const entry = { at: new Date(now()).toISOString(), event, webContentsId: contents.id, ...details };
    console.error('[Renderer Recovery]', entry);
    try {
      mkdirSync(options.logDirectory, { recursive: true });
      const file = join(options.logDirectory, 'renderer-recovery.jsonl');
      if (existsSync(file) && statSync(file).size >= MAX_LOG_BYTES) {
        renameSync(file, `${file}.previous`);
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      console.error('[Renderer Recovery] Could not write diagnostic log');
    }
  }

  function sample(): void {
    if (unavailable()) return;
    try {
      const memory = options.sampleMemory?.();
      if (memory) samples = [...samples.slice(-7), { at: now(), ...memory }];
    } catch { /* Memory sampling must never affect the task. */ }
  }
  const memoryTimer = setInterval(sample, 15_000);
  memoryTimer.unref();

  function reload(): void {
    if (unavailable()) return;
    record('reload');
    try {
      contents.reload();
    } catch {
      record('reload-failed');
      void offerRetry();
    }
  }

  async function offerRetry(): Promise<void> {
    if (unavailable() || offeringRetry) return;
    offeringRetry = true;
    try {
      if (await options.offerRetry() && !unavailable()) {
        // A manual retry does not reset the automatic crash-loop budget.
        reloadTimer = setTimeout(() => { reloadTimer = undefined; reload(); }, options.retryDelayMs ?? 500);
      }
    } catch {
      record('retry-dialog-failed');
    } finally {
      offeringRetry = false;
    }
  }

  contents.on('render-process-gone', (_event, details) => {
    if (unavailable() || details.reason === 'clean-exit') return;
    if (reloadTimer) clearTimeout(reloadTimer);
    const timestamp = now();
    crashes = crashes.filter(at => timestamp - at < CRASH_WINDOW_MS);
    crashes.push(timestamp);
    record('crashed', { reason: details.reason, exitCode: details.exitCode, crashesInWindow: crashes.length, memory: samples });
    samples = [];
    if (crashes.length <= MAX_AUTOMATIC_RELOADS) {
      reloadTimer = setTimeout(() => { reloadTimer = undefined; reload(); }, options.retryDelayMs ?? 500);
    } else {
      record('automatic-recovery-paused');
      void offerRetry();
    }
  });
  contents.on('did-finish-load', sample);
  win.once('closed', () => {
    disposed = true;
    clearInterval(memoryTimer);
    if (reloadTimer) clearTimeout(reloadTimer);
  });
}

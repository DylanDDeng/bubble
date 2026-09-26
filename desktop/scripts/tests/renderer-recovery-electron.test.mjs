import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), 'bubble-renderer-recovery-electron-'));
try {
  await mkdir(path.join(dir, 'bubble-home'));
  const modulePath = path.join(root, 'src/electron/libs/renderer-recovery.ts');
  const deliveryPath = path.join(root, 'src/electron/libs/renderer-event-delivery.ts');
  await build({
    stdin: { resolveDir: root, contents: `
      const { app, BrowserWindow, ipcMain } = require('electron');
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const { installRendererRecovery } = require(${JSON.stringify(modulePath)});
      const { sendRendererEvent } = require(${JSON.stringify(deliveryPath)});
      app.setPath('userData', path.join(process.env.QA_ROOT, 'profile'));
      app.setPath('sessionData', path.join(process.env.QA_ROOT, 'session-data'));
      let ticks = 0, offers = 0, loads = 0;
      const task = { status: 'running', history: ['started'], controller: new AbortController() };
      let display;
      const heartbeat = setInterval(() => {
        ticks++; task.history.push('progress');
        if (display) sendRendererEvent(display, { type: 'session.status', payload: { sessionId: 'qa', status: 'running' } });
      }, 10);
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const until = async (predicate, label) => {
        for (let i=0;i<200;i++) { if (predicate()) return; await delay(25); }
        throw Error('Timed out: ' + label);
      };
      const watchdog = setTimeout(() => { console.error('QA timeout'); app.exit(1); }, 25000);
      app.whenReady().then(async () => {
        const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
        display = w;
        const hostPid = process.pid, webContentsId = w.webContents.id;
        ipcMain.handle('task-status', () => ({ status: task.status, ticks, messages: task.history.length }));
        w.webContents.on('did-finish-load', () => { loads++; });
        installRendererRecovery(w, {
          isQuitting: () => false, logDirectory: path.join(process.env.QA_ROOT, 'logs'), retryDelayMs: 20,
          offerRetry: async () => { offers++; return false; },
        });
        try {
          const html = path.join(process.env.QA_ROOT, 'display.html');
          fs.writeFileSync(html, '<!doctype html><body>Task view ready</body>');
          await w.loadFile(html);
          for (let crash=0;crash<2;crash++) {
            const before = ticks, oldRenderer = w.webContents.getOSProcessId();
            w.webContents.forcefullyCrashRenderer();
            await until(() => loads === crash + 2, 'renderer reload');
            assert.notEqual(w.webContents.getOSProcessId(), oldRenderer);
            assert.equal(w.webContents.id, webContentsId, 'same WebContents and IPC bindings');
            assert.equal(process.pid, hostPid);
            assert(!task.controller.signal.aborted);
            const state = await w.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('task-status')");
            assert.equal(state.status, 'running');
            assert(state.ticks > before && state.messages > 1, 'background work continues across crash');
            assert.equal(await w.webContents.executeJavaScript('document.body.textContent'), 'Task view ready');
          }
          w.webContents.forcefullyCrashRenderer();
          await until(() => offers === 1, 'bounded recovery offers native retry');
          await delay(200);
          assert.equal(loads, 3, 'third crash does not loop');
          assert(!task.controller.signal.aborted);
          const log = fs.readFileSync(path.join(process.env.QA_ROOT, 'logs/renderer-recovery.jsonl'), 'utf8');
          assert.equal(log.split('"event":"crashed"').length - 1, 3);
          console.log('PASS native Electron: two real renderer crashes recover; main-process task and IPC survive; third crash stops reload loop');
          clearInterval(heartbeat); clearTimeout(watchdog); w.destroy(); app.exit(0);
        } catch (error) { console.error(error); app.exit(1); }
      });
    ` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(dir, 'main.cjs'),
  });
  const env = { ...process.env, QA_ROOT: dir, BUBBLE_HOME: path.join(dir, 'bubble-home'), BUBBLE_DESKTOP_PROFILE: 'qa', BUBBLE_DESKTOP_QA_ROOT: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw Error('Renderer recovery Electron test failed: ' + code);
} finally { await rm(dir, { recursive: true, force: true }); }

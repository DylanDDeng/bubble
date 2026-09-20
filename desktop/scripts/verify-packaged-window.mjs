import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';

/** Launch the actual packaged executable, with both stores isolated by caller. */
export async function verifyPackagedWindow(app, env, cwd) {
  assert.equal(env.BUBBLE_DESKTOP_PROFILE, 'qa');
  assert(env.BUBBLE_DESKTOP_QA_ROOT);
  const child = spawn(join(app, 'Contents/MacOS/Bubble'), ['--remote-debugging-port=0'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-20000); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  let socket;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + 45000;
  try {
    let page;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Packaged app exited: ${output}`);
      try {
        const port = (await readFile(join(env.BUBBLE_DESKTOP_QA_ROOT, 'desktop/DevToolsActivePort'), 'utf8')).split('\n')[0];
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
        page = targets.find(target => target.type === 'page' && target.url.startsWith('file:') && target.url.includes('dist-react/index.html'));
        if (page) break;
      } catch { /* wait for the packaged main process and renderer */ }
      await pause(200);
    }
    assert(page, `Packaged window did not load: ${output}`);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let sequence = 0;
    function evaluate(expression) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Packaged renderer RPC timed out')); }, 5000);
        const receive = message => {
          const response = JSON.parse(String(message));
          if (response.id !== id) return;
          clearTimeout(timer); socket.off('message', receive);
          if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)));
          else resolve(response.result?.result?.value);
        };
        socket.on('message', receive);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    }
    let ready = false;
    while (Date.now() < deadline) {
      ready = await evaluate("Boolean(document.getElementById('root')?.childElementCount && window.electron?.getBubbleModelConfig && document.body.innerText.trim())");
      if (ready) break;
      await pause(200);
    }
    assert(ready, `Renderer did not mount or preload failed: ${output}`);
    const catalog = await evaluate('window.electron.getBubbleModelConfig()');
    assert.deepEqual(catalog.options, [], 'isolated QA must not import real provider credentials');
    assert(!/Cannot find module|ERR_MODULE_NOT_FOUND|Unable to load preload script/.test(output), output);
    console.log('PASS: packaged executable mounts its UI and serves model IPC with isolated empty data.');
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 25 && child.exitCode === null && child.signalCode === null; attempt++) await pause(200);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
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
    // Exercise the packaged main/preload boundary, not only source fixtures.
    const home = JSON.stringify(homedir());
    const blockedTree = await evaluate(`window.electron.getProjectTree(${home})`);
    assert(blockedTree.scanNotice && blockedTree.children.length === 0, 'home index is blocked');
    assert.equal(await evaluate(`window.electron.watchProjectTree(${home})`), false);
    const privateFile = JSON.stringify(join(homedir(), 'Music', 'bubble-privacy-nonexistent.png'));
    const blockedPreview = await evaluate(`window.electron.readProjectFilePreview(${home}, ${privateFile})`);
    assert.equal(blockedPreview.kind, 'error');
    assert.match(blockedPreview.message, /not previewed automatically/, 'private path is refused before a missing-file probe');
    const project = join(cwd, 'privacy-project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'hello.txt'), 'safe project preview');
    const safeTree = await evaluate(`window.electron.getProjectTree(${JSON.stringify(project)})`);
    assert(safeTree.children.some(entry => entry.name === 'hello.txt'));
    const safePreview = await evaluate(`window.electron.readProjectFilePreview(${JSON.stringify(project)}, 'hello.txt')`);
    assert.equal(safePreview.kind, 'text');
    // A valid MP4 plus a sparse free box tests large-file streaming without
    // downloading a fixture or allocating the entire video in the renderer.
    const largeTextPath = join(project, 'large.txt');
    const textHandle = await open(largeTextPath, 'w');
    try { await textHandle.truncate(6 * 1024 * 1024); } finally { await textHandle.close(); }
    const largeText = await evaluate(`window.electron.readProjectFilePreview(${JSON.stringify(project)}, ${JSON.stringify(largeTextPath)})`);
    assert.equal(largeText.kind, 'too_large', 'buffered text retains its memory limit');
    const videoBytes = await readFile(new URL('./tests/fixtures/video-preview.mp4', import.meta.url));
    const videoPath = join(project, '大视频 #1.mp4');
    const freeBox = Buffer.alloc(8);
    freeBox.writeUInt32BE(64 * 1024 * 1024);
    freeBox.write('free', 4);
    await writeFile(videoPath, Buffer.concat([videoBytes, freeBox]));
    const handle = await open(videoPath, 'r+');
    try { await handle.truncate(videoBytes.length + 64 * 1024 * 1024); } finally { await handle.close(); }
    const video = await evaluate(`window.electron.readProjectFilePreview(${JSON.stringify(project)}, ${JSON.stringify(videoPath)})`);
    assert.equal(video.kind, 'video', 'streaming video must bypass the 5 MiB buffered-file limit');
    const head = await fetch(video.previewUrl, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), video.size);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(head.headers.get('content-type'), 'video/mp4');
    const range = await fetch(video.previewUrl, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-1023/${video.size}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), videoBytes.subarray(0, 1024));
    const suffix = await fetch(video.previewUrl, { headers: { Range: 'bytes=-128' } });
    assert.equal(suffix.status, 206);
    assert.equal((await suffix.arrayBuffer()).byteLength, 128);
    const invalid = await fetch(video.previewUrl, { headers: { Range: `bytes=${video.size}-` } });
    assert.equal(invalid.status, 416);
    const invalidToken = new URL(video.previewUrl); invalidToken.pathname = '/invalid/video.mp4';
    assert.equal((await fetch(invalidToken)).status, 404);
    const playback = await evaluate(`new Promise(resolve => {
      const violations = [];
      const record = event => violations.push(event.effectiveDirective);
      document.addEventListener('securitypolicyviolation', record);
      const player = document.createElement('video');
      player.muted = true; player.preload = 'metadata'; player.controls = true;
      let finished = false;
      const done = result => { if (finished) return; finished = true; clearTimeout(timer); player.pause(); player.removeAttribute('src'); player.load(); player.remove(); document.removeEventListener('securitypolicyviolation', record); resolve({...result, violations}); };
      const timer = setTimeout(() => done({error: 'timeout'}), 4000);
      player.onerror = () => done({error: player.error?.message});
      player.onloadedmetadata = () => { player.currentTime = 1; };
      player.onseeked = () => { player.onseeked = null; player.play().then(() => setTimeout(() => done({time: player.currentTime, duration: player.duration, width: player.videoWidth}), 250)).catch(error => done({error: String(error)})); };
      player.src = ${JSON.stringify(video.previewUrl)}; document.body.append(player);
    })`);
    assert.equal(playback.error, undefined, JSON.stringify(playback));
    assert(playback.time > 1 && playback.duration >= 3 && playback.width === 160, JSON.stringify(playback));
    assert.deepEqual(playback.violations, [], 'production CSP must permit tokenized loopback media');
    console.log('PASS: packaged UI, privacy guards, large MP4 metadata/playback/seek and HTTP range/token handling.');
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 25 && child.exitCode === null && child.signalCode === null; attempt++) await pause(200);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

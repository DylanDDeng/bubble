// Live-resize smoothness in the full App: frame pacing, long tasks, and how
// far the native browser view lags behind the window while it is resized.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

module.exports = async ({ js, delay, win, root }) => {
  const { browserManager } = require(path.join(root, 'dist-electron/electron/browserManager.js'));
  const page = new http.Server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Resize page</title><h1>resize</h1>'); });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${page.address().port}/`;
  const until = async (expr, label) => { for (let i = 0; i < 200; i++) { if (await js(expr)) return; await delay(50); } throw Error('Timed out: ' + label); };

  const boundsLog = [];
  const original = browserManager.setPanelBounds.bind(browserManager);
  browserManager.setPanelBounds = (input) => { boundsLog.push({ t: performance.now(), b: input.bounds }); return original(input); };

  const run = async (label) => {
    win.setBounds({ x: 40, y: 40, width: 1280, height: 820 }); await delay(600);
    await js(`(()=>{qa.frames=[];qa.long=[];qa.obs?.disconnect();qa.obs=new PerformanceObserver(l=>{for(const e of l.getEntries())qa.long.push(e.duration)});qa.obs.observe({type:'longtask',buffered:false});
      qa.stopRaf=false;const loop=t=>{qa.frames.push(t);if(!qa.stopRaf)requestAnimationFrame(loop)};requestAnimationFrame(loop)})()`);
    boundsLog.length = 0;
    const steps = [];
    const widths = [];
    for (let i = 0; i <= 40; i++) widths.push(Math.round(1280 - 420 * Math.sin((i / 40) * Math.PI)));
    for (const w of widths) { steps.push({ t: performance.now(), w }); win.setBounds({ x: 40, y: 40, width: w, height: 820 }); await delay(16); }
    await delay(500);
    const { frames, long } = await js('(()=>{qa.stopRaf=true;qa.obs.disconnect();return {frames:qa.frames,long:qa.long}})()');
    const gaps = frames.slice(1).map((t, i) => t - frames[i]);
    const report = { label, frames: gaps.length, over25ms: gaps.filter(g => g > 25).length, over50ms: gaps.filter(g => g > 50).length,
      maxFrameMs: Math.round(Math.max(...gaps)), longTasks: long.length, longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)) };
    if (boundsLog.length) {
      // The view's right edge sits a fixed distance from the window's right edge.
      const settled = boundsLog.at(-1).b; const inset = 1280 - (settled.x + settled.width);
      const lags = steps.map(s => { const hit = boundsLog.find(e => e.t >= s.t && Math.abs((e.b.x + e.b.width) - (s.w - inset)) <= 1); return hit ? hit.t - s.t : null; });
      // Steps at the starting width need no new bounds; they cannot lag.
      steps.forEach((s, i) => { if (s.w === 1280) lags[i] = null; });
      report.worstStep = lags.reduce((best, l, i) => (l != null && (best < 0 || l > lags[best]) ? i : best), -1);
      const ok = lags.filter(l => l != null);
      report.boundsUpdates = boundsLog.length;
      report.viewLagMs = { median: Math.round(ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? -1), max: Math.round(Math.max(...ok)), missedSteps: steps.filter(s => s.w !== 1280).length - ok.length };
    }
    console.log('RESIZE_PERF ' + JSON.stringify(report));
    return report;
  };

  try {
    await run('browser closed');
    await js(`qa.app.getState().openRightUtilityTab('browser')`);
    await until('!!document.querySelector("input[placeholder=\\"Search or enter a URL\\"]")', 'browser panel');
    await js(`(()=>{const i=document.querySelector('input[placeholder="Search or enter a URL"]');i.focus();
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(target)});
      i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    await delay(1500);
    const open = await run('browser open');
    // Generous bounds (machines get busy); before the fix this measured 13
    // frames over 25ms, a 51ms median view lag and 9 skipped sizes.
    assert.equal(open.over50ms, 0, 'no frame over 50ms while resizing with a page open');
    assert.ok(open.viewLagMs.median <= 25, 'the page follows the window within a couple of frames');
    assert.equal(open.viewLagMs.missedSteps, 0, 'every window size reaches the page');
    console.log('RESIZE_PERF_PASS');
  } finally {
    browserManager.setPanelBounds = original;
    page.close();
    await js('qa.app.getState().rightUtilityTabs.slice().forEach(id => qa.app.getState().closeRightUtilityTab(id))').catch(() => {});
    await delay(300);
  }
};

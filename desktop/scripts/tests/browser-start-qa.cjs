// Full-App browser panel QA with real input: a recent page picked on the start
// page must open and stay open, and a failed load must show the panel's error
// page whose "Try again" really reloads.
const assert = require('node:assert/strict');
const http = require('node:http');

module.exports = async ({ js, click, capture, delay }) => {
  const listen = (server, port = 0) => new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
  const page = new http.Server((req, res) => {
    if (req.url === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#e5484d"/></svg>');
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>${req.url === '/retry' ? 'Retry page' : 'Fixture page'}</title><link rel="icon" href="/icon.svg"><p>loaded</p>`);
    }, 400);
  });
  const port = await listen(page);
  // Reserve a port, then free it: loads fail until "Try again".
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const typeAddress = url => js(`(()=>{const i=document.querySelector('input[placeholder="Search or enter a URL"]');i.focus();
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(url)});
    i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  const until = async (expr, label) => {
    for (let i = 0; i < 200; i++) { if (await js(expr)) return; await delay(50); }
    throw Error('Timed out: ' + label + ' ' + await js('JSON.stringify(qa.browserTab())'));
  };
  try {
    const target = `http://127.0.0.1:${port}/newbie-tutorials/how-to-talk-to-ai/`;
    const dead = `http://127.0.0.1:${deadPort}/retry`;
    await js(`(async()=>{
      const { useBrowserStateStore } = await import('/src/ui/store/useBrowserStateStore.ts');
      const sid = qa.app.getState().activeSessionId;
      for (const [url, title, at] of [[${JSON.stringify(dead)}, 'Retry page', 1], [${JSON.stringify(target)}, 'Bubble News', 2]])
        useBrowserStateStore.getState().recordHistoryEntry(sid, { url, title, lastVisitedAt: Date.now() + at });
      qa.browserTab = () => { const s = useBrowserStateStore.getState().sessionStatesBySessionId[sid]; return s && s.tabs.find(t => t.id === s.activeTabId); };
      qa.app.getState().openRightUtilityTab('browser');
    })()`);
    await until('!!document.querySelector("[data-browser-start-page] .bubble-browser-recents button")', 'start page with recents');
    // As in the field: the tab has already shown a page (its view is live)
    // before it returns to the start page.
    await typeAddress(`http://127.0.0.1:${port}/warmup`);
    await until(`qa.browserTab()?.title === 'Fixture page' && !qa.browserTab()?.isLoading`, 'warm-up page');
    await typeAddress('about:blank');
    await until('!!document.querySelector("[data-browser-start-page] .bubble-browser-recents button")', 'back on the start page');
    await delay(600);
    await capture('browser-start-page');

    // 1. Pick a recent page on the start page.
    await click(`.bubble-browser-recents button[title="${target}"]`);
    await until(`qa.browserTab()?.title === 'Fixture page' && !qa.browserTab()?.isLoading`, 'recent page loads');
    for (let i = 0; i < 10; i++) {
      assert.equal(await js('!!document.querySelector("[data-browser-start-page]")'), false, 'start page stays dismissed');
      await delay(100);
    }
    assert.equal(await js('qa.browserTab().url'), target);
    assert.equal(await js('document.querySelector("input[placeholder=\\"Search or enter a URL\\"]").value.includes("/newbie-tutorials/how-to-talk-to-ai/")'), true, 'address bar shows the page');
    // The tab strip shows the page's own favicon, not the generic globe.
    const tabIcon = '[data-utility-tab-kind="browser"] img';
    await until(`document.querySelector('${tabIcon}')?.complete && document.querySelector('${tabIcon}').naturalWidth > 0`, 'favicon in the tab strip');
    assert.equal(await js(`document.querySelector('${tabIcon}').getAttribute('src')`), `http://127.0.0.1:${port}/icon.svg`);
    await capture('browser-recent-opened');

    // 2. A failed load shows the panel's error page instead of a blank view.
    await typeAddress(dead);
    await until('!!document.querySelector("[data-browser-error-page]")', 'error page');
    await delay(800);
    assert.equal(await js('!!document.querySelector("[data-browser-error-page]")'), true, 'error page stays');
    assert.match(await js('document.querySelector("[data-browser-error-page] h2").textContent'), /refused|Couldn't/);
    assert.equal(await js(`!!document.querySelector('${tabIcon}')`), false, 'a failed page does not keep the previous site icon');
    await capture('browser-load-error');

    // 3. The server comes back; "Try again" reloads the same URL.
    const retry = new http.Server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Retry page</title><p>ok</p>'); });
    await listen(retry, deadPort);
    try {
      await click('[data-browser-error-page] button');
      await until(`qa.browserTab()?.title === 'Retry page' && !qa.browserTab()?.isLoading`, 'retry loads');
      assert.equal(await js('!!document.querySelector("[data-browser-error-page]")'), false, 'error page dismissed after retry');
      await capture('browser-retry-loaded');
    } finally {
      retry.close();
    }
    console.log('BROWSER_START_QA_PASS');
  } finally {
    page.close();
    // Leave no persisted browser tab behind for the restore phase's header checks.
    await js('qa.app.getState().rightUtilityTabs.slice().forEach(id => qa.app.getState().closeRightUtilityTab(id))').catch(() => {});
    await delay(300);
  }
};

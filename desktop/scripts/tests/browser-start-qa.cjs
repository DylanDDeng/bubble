// Full-App browser panel QA with real input: a recent page picked on the start
// page must open and stay open, and a failed load must show the panel's error
// page whose "Try again" really reloads.
const assert = require('node:assert/strict');
const http = require('node:http');

// A Chrome-shaped fixture stands in for the user's real browsers; the import
// QA stops before Keychain so it never touches real browser data.
function writeChromeFixture() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chrome-fixture-'));
  fs.mkdirSync(path.join(root, 'Default', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'QA Person' } } } }));
  const db = new Database(path.join(root, 'Default', 'Network', 'Cookies'));
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE cookies(host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, is_persistent INTEGER, samesite INTEGER)`);
  const insert = db.prepare(`INSERT INTO cookies VALUES (?, '', ?, 'v', x'', '/', 0, 1, 1, 0, 0, 1)`);
  for (const [host, name] of [['.github.com', 'a'], ['github.com', 'b'], ['.example.org', 'c']]) insert.run(host, name);
  db.close();
  process.env.AEGIS_CHROME_USER_DATA_DIR = root;
  process.env.AEGIS_CHROME_COOKIE_IMPORT_STATE_PATH = path.join(root, 'import-state.json');
}

module.exports = async ({ js, click, capture, delay, win }) => {
  writeChromeFixture();
  const listen = (server, port = 0) => new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
  const page = new http.Server((req, res) => {
    if (req.url === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#e5484d"/></svg>');
      return;
    }
    if (req.url === '/find') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>Find page</title><p>apple banana apple cherry apple</p><a href="/linked">a link</a>`);
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

    // Suggestions and the actions menu cover the page with its snapshot, never a blank viewport.
    const address = 'input[placeholder="Search or enter a URL"]';
    assert.equal(await js(`document.querySelector('${address}').value`), `127.0.0.1:${port}/newbie-tutorials/how-to-talk-to-ai/`, 'resting address hides the scheme');
    await click(address);
    await until(`!!document.querySelector('.bubble-address-history') && !!document.querySelector('[data-browser-page-snapshot]')`, 'suggestions over the page snapshot');
    assert.equal(await js(`document.querySelector('${address}').value`), target, 'editing shows the full URL');
    await capture('browser-suggestions');
    await js(`document.querySelector('${address}').blur()`);
    await until(`!document.querySelector('.bubble-address-history') && !document.querySelector('[data-browser-page-snapshot]')`, 'snapshot released after editing');
    await click('[data-browser-actions-trigger]');
    await until(`!!document.querySelector('[data-browser-actions-menu]') && !!document.querySelector('[data-browser-page-snapshot]')`, 'actions menu over the page snapshot');
    assert.deepEqual(
      JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('[data-browser-actions-menu] [role="menuitem"]')].map(item => item.textContent.trim()))`)),
      ['Send page content to chat', 'Copy URL', 'Open in external browser', 'Find in page⌘F', 'Import from browser…', 'Clear browsing data…', 'Open DevTools'],
    );
    await capture('browser-actions-menu');
    await js(`document.querySelector('[data-browser-actions-menu]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('[data-browser-actions-menu]') && !document.querySelector('[data-browser-page-snapshot]')`, 'menu closes and releases the snapshot');
    // App-level overlays (the tab strip's "+" menu) also keep the page visible.
    await click('[aria-label="Open another panel"]');
    await until(`[...document.querySelectorAll('[role="menuitem"]')].some(i => i.textContent.includes('New tab')) && !!document.querySelector('[data-browser-page-snapshot]')`, 'tab menu over the page snapshot');
    await capture('browser-tab-menu');
    await js(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('[role="menu"]') && !document.querySelector('[data-browser-page-snapshot]')`, 'tab menu closes and releases the snapshot');

    // 2. A failed load shows the panel's error page instead of a blank view.
    await typeAddress(dead);
    await until('!!document.querySelector("[data-browser-error-page]")', 'error page');
    await delay(800);
    assert.equal(await js('!!document.querySelector("[data-browser-error-page]")'), true, 'error page stays');
    assert.equal(await js('document.querySelector("[data-browser-error-page] h2").textContent'), "This site can't be reached");
    assert.match(await js('document.querySelector("[data-browser-error-page]").textContent'), /refused to connect.*ERR_CONNECTION_REFUSED/);
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

    // 4. The import banner opens the import dialog; the site picker lists the profile's hosts.
    const banner = '[data-browser-import-banner]';
    await until(`document.querySelector('${banner}')?.textContent.includes('Import data from Google Chrome')`, 'import banner');
    await capture('browser-import-banner');
    await js(`[...document.querySelectorAll('${banner} button')].find(b => b.textContent.trim() === 'Import').click()`);
    const importDialog = '[data-testid="browser-import-dialog"]';
    await until(`document.querySelector('${importDialog}')?.textContent.includes('QA Person')`, 'import dialog with the fixture profile');
    assert.equal(await js('!!document.querySelector("[data-browser-page-snapshot]")'), true, 'the page stays visible behind the dialog');
    await js(`[...document.querySelectorAll('${importDialog} [role="radio"]')].find(b => b.textContent === 'Choose sites').click()`);
    await until(`document.querySelectorAll('${importDialog} [data-browser-import-sites] label').length === 2`, 'site picker');
    assert.deepEqual(
      JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('${importDialog} [data-browser-import-sites] label')].map(l => l.textContent))`)),
      ['github.com2', 'example.org1'],
    );
    assert.equal(await js(`[...document.querySelectorAll('${importDialog} button')].find(b => b.textContent === 'Import').disabled`), true, 'no site chosen yet');
    await js(`document.querySelector('${importDialog} [data-browser-import-sites] [role="checkbox"]').click()`);
    assert.equal(await js(`[...document.querySelectorAll('${importDialog} button')].find(b => b.textContent === 'Import').disabled`), false);
    await delay(300);
    await capture('browser-import-dialog');
    await js(`[...document.querySelectorAll('${importDialog} button')].find(b => b.textContent === 'Cancel').click()`);
    await until(`!document.querySelector('${importDialog}')`, 'import dialog closes');

    // 5. Clear browsing data: cookies and cache only apply to All time.
    await click('[data-browser-actions-trigger]');
    await until(`!!document.querySelector('[data-browser-actions-menu]')`, 'actions menu');
    await js(`[...document.querySelectorAll('[data-browser-actions-menu] [role="menuitem"]')].find(i => i.textContent.includes('Clear browsing data')).click()`);
    const clearDialog = '[data-testid="browser-clear-data-dialog"]';
    await until(`!!document.querySelector('${clearDialog}')`, 'clear data dialog');
    assert.equal(await js(`document.querySelector('#browser-clear-siteData').disabled`), true, 'site data needs All time');
    await js(`[...document.querySelectorAll('${clearDialog} [role="radio"]')].find(b => b.textContent === 'All time').click()`);
    await until(`document.querySelector('#browser-clear-siteData').disabled === false && document.querySelector('${clearDialog}').textContent.includes('Current cache size')`, 'all-time rows enabled');
    await delay(300);
    await capture('browser-clear-data');
    await js(`[...document.querySelectorAll('${clearDialog} button')].find(b => b.textContent === 'Delete data').click()`);
    await until(`!document.querySelector('${clearDialog}')`, 'clear data dialog closes');
    assert.equal(
      await js(`(async () => { const { useBrowserStateStore } = await import('/src/ui/store/useBrowserStateStore.ts'); return Object.values(useBrowserStateStore.getState().recentHistoryBySessionId).flat().length; })()`),
      0,
      'all-time history cleared'
    );
    assert.equal(
      await js(`window.electron.browser.getDataSummary().then(s => s.cookieSiteCount)`),
      0,
      'site data cleared'
    );

    // 6. Dismissing the banner keeps it dismissed.
    await js(`document.querySelector('${banner} [aria-label="Dismiss browser data import banner"]').click()`);
    await until(`!document.querySelector('${banner}')`, 'banner dismissed');

    // 7. A fresh tab's view has no capturable frame yet; its first overlay must still show the page.
    await js(`qa.app.getState().openRightUtilityTab('browser', { newTab: true })`);
    const visibleAddress = `[...document.querySelectorAll('input[placeholder="Search or enter a URL"]')].find(i => i.offsetParent)`;
    await until(`!!${visibleAddress} && ${visibleAddress}.value === ''`, 'fresh browser tab');
    await js(`(()=>{const i=${visibleAddress};i.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(`http://127.0.0.1:${port}/fresh-tab`)});
      i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));i.blur();})()`);
    await until(`[...document.querySelectorAll('[data-utility-tab-kind="browser"]')].some(t => t.textContent.includes('Fixture page'))`, 'fresh tab page');
    await delay(1200);
    await click('[aria-label="Open another panel"]');
    await until(`!!document.querySelector('[role="menu"]') && !!document.querySelector('[data-browser-page-snapshot]')`, 'first overlay on a fresh tab keeps the page');
    await js(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('[role="menu"]')`, 'tab menu closes');

    // 8. Find in page, zoom, open link in new tab, and the tab strip's right-click menu.
    const path = require('node:path');
    const { browserManager } = require(path.join(process.env.QA_ROOT, 'dist-electron/electron/browserManager.js'));
    const pageContents = () => browserManager.attachedView.webContents;
    await js(`(()=>{const i=${visibleAddress};i.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(`http://127.0.0.1:${port}/find`)});
      i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));i.blur();})()`);
    await until(`[...document.querySelectorAll('[data-utility-tab-kind="browser"]')].some(t => t.textContent.includes('Find page'))`, 'find fixture page');
    await delay(600);

    // An IME's Enter commits the composed letters; it must not navigate.
    const activePageUrl = () => {
      const state = browserManager.getState({ sessionId: browserManager.activeSessionId });
      return state.tabs.find((tab) => tab.id === state.activeTabId)?.url;
    };
    await js(`(()=>{const i=${visibleAddress};i.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'example.com');
      i.dispatchEvent(new Event('input',{bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true}));})()`);
    await delay(500);
    assert.equal(activePageUrl(), `http://127.0.0.1:${port}/find`, 'composition Enter does not navigate');
    assert.equal(await js(`${visibleAddress}.value`), 'example.com', 'composed text stays in the address bar');
    await js(`(()=>{const i=${visibleAddress};i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));i.blur();})()`);
    await delay(200);
    assert.equal(activePageUrl(), `http://127.0.0.1:${port}/find`, 'Escape restores without navigating');
    const findInput = '[data-browser-find-bar] input';
    const findCount = `document.querySelector('[data-browser-find-bar] [aria-live]').textContent`;
    // Cmd+F typed into the page itself reaches the panel through the main process.
    pageContents().focus();
    pageContents().sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['meta'] });
    await until(`!!document.querySelector('${findInput}') && document.activeElement === document.querySelector('${findInput}')`, 'Cmd+F in the page opens a focused find bar');
    await js(`(()=>{const i=document.querySelector('${findInput}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'apple');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`${findCount} === '1 of 3'`, 'find counts matches');
    await js(`document.querySelector('${findInput}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await until(`${findCount} === '2 of 3'`, 'Enter moves to the next match');
    await js(`document.querySelector('${findInput}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))`);
    await until(`${findCount} === '1 of 3'`, 'Shift+Enter moves back');
    await delay(200);
    await capture('browser-find-bar');
    await js(`document.querySelector('${findInput}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('[data-browser-find-bar]')`, 'Escape closes the find bar');

    // Cmd+= in the page zooms the page (not the app UI); the address bar shows the level.
    const appZoom = win.webContents.getZoomFactor();
    pageContents().focus();
    pageContents().sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['meta'] });
    await until(`document.querySelector('[data-browser-zoom-indicator]')?.textContent === '110%'`, 'page zoom indicator');
    assert.equal(win.webContents.getZoomFactor(), appZoom, 'the app UI zoom is untouched');
    assert.equal(Math.round(pageContents().getZoomFactor() * 100), 110);
    assert.equal(await js(`document.querySelector('[data-browser-zoom-control]').dataset.expanded`), 'true', 'a zoom change expands − % +');
    const addressPadding = `(() => { const s = getComputedStyle(${visibleAddress}); return s.paddingLeft + '|' + s.paddingRight; })()`;
    const [padLeft, padRight] = (await js(addressPadding)).split('|');
    assert.equal(padLeft, padRight, 'the zoom control keeps the address text centered');
    await capture('browser-zoom');
    await click('[data-browser-zoom-indicator]');
    await until(`!document.querySelector('[data-browser-zoom-indicator]')`, 'indicator click resets zoom');
    assert.equal(Math.round(pageContents().getZoomFactor() * 100), 100);

    // Zooming from the ⋯ menu closes it, so the page (not its frozen snapshot) shows the change.
    const trigger = await js(`(() => { const r = [...document.querySelectorAll('[data-browser-actions-trigger]')].find(b => b.offsetParent).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...trigger });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...trigger });
    await until(`!!document.querySelector('[data-browser-zoom-controls]')`, 'menu zoom row');
    await js(`document.querySelector('[data-browser-zoom-controls] [aria-label="Zoom in"]').click()`);
    await until(`!document.querySelector('[data-browser-actions-menu]') && !document.querySelector('[data-browser-page-snapshot]')`, 'menu closes and the live page returns');
    await until(`document.querySelector('[data-browser-zoom-indicator]')?.textContent === '110%'`, 'menu zoom applied');
    assert.equal(Math.round(pageContents().getZoomFactor() * 100), 110);
    pageContents().focus();
    pageContents().sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['meta'] });
    await until(`!document.querySelector('[data-browser-zoom-indicator]')`, 'Cmd+0 resets zoom');

    // "Open link in new tab" (page context menu) opens a tab right after this one.
    const tabCount = `document.querySelectorAll('[data-utility-tab-kind="browser"]').length`;
    const tabsBefore = await js(tabCount);
    const owner = browserManager.activeSessionId;
    browserManager.emitPanelEvent({ type: 'open-in-new-tab', sessionId: owner, tabId: browserManager.getState({ sessionId: owner }).activeTabId, url: `http://127.0.0.1:${port}/linked` });
    await until(`${tabCount} === ${tabsBefore + 1}`, 'link opens in a new tab');
    await until(`[...document.querySelectorAll('[data-utility-tab-kind="browser"]')].some(t => t.textContent.includes('Fixture page') && t.closest('[class*="sidebar-item-active"]'))`, 'new tab is active and loads the link');

    // Tab right-click menu: duplicate, then close the others.
    const activeTabTrigger = `[...document.querySelectorAll('[data-utility-tab-kind="browser"]')].find(t => t.closest('[class*="sidebar-item-active"]')).parentElement`;
    await js(`(()=>{const t=${activeTabTrigger};const r=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+10,clientY:r.y+10}));})()`);
    await until(`!!document.querySelector('[data-utility-tab-menu]')`, 'tab context menu');
    assert.deepEqual(
      JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('[data-utility-tab-menu] [role="menuitem"]')].map(i => i.textContent.trim()))`)),
      ['Reload', 'Duplicate', 'New tab to the right', 'Copy URL', 'Open in external browser', 'Close', 'Close other tabs', 'Close tabs to the right'],
    );
    await delay(200);
    await capture('browser-tab-context-menu');
    await js(`[...document.querySelectorAll('[data-utility-tab-menu] [role="menuitem"]')].find(i => i.textContent.trim() === 'Duplicate').click()`);
    await until(`${tabCount} === ${tabsBefore + 2}`, 'duplicate adds a tab');
    await js(`(()=>{const t=${activeTabTrigger};const r=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+10,clientY:r.y+10}));})()`);
    await until(`!!document.querySelector('[data-utility-tab-menu]')`, 'tab context menu again');
    await js(`[...document.querySelectorAll('[data-utility-tab-menu] [role="menuitem"]')].find(i => i.textContent.trim() === 'Close other tabs').click()`);
    await until(`document.querySelectorAll('[data-utility-tab]').length === 1`, 'close other tabs leaves one');
    console.log('BROWSER_START_QA_PASS');
  } finally {
    page.close();
    // Leave no persisted browser tab behind for the restore phase's header checks.
    await js('qa.app.getState().rightUtilityTabs.slice().forEach(id => qa.app.getState().closeRightUtilityTab(id))').catch(() => {});
    await delay(300);
  }
};

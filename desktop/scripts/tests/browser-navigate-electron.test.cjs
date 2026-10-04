// Real Electron WebContentsView: a new tab navigating away from about:blank
// must report its target URL for the whole load, never the page it is leaving.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Runtime tests isolate both Electron userData and Bubble's Agent data.
const qaData = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-browser-nav-'));
app.setPath('userData', path.join(qaData, 'profile'));
process.env.BUBBLE_HOME = path.join(qaData, 'agent');
fs.mkdirSync(process.env.BUBBLE_HOME, { recursive: true });

app.whenReady().then(async () => {
  let exitCode = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/no-content') { res.writeHead(204); res.end(); return; }
    // Hold the response so the uncommitted window is wide, as on a real network.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>${req.url === '/second' ? 'Second page' : 'Fixture page'}</title><p>loaded</p>`);
    }, 600);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { browserManager } = require(path.resolve(__dirname, '../../dist-electron/electron/browserManager.js'));
    const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
    await win.loadURL('data:text/html,<p>host</p>');
    browserManager.setWindow(win);
    const bounds = { x: 400, y: 80, width: 600, height: 600 };
    // A fresh tab whose very first load commits nothing (204) falls back to
    // the start page instead of claiming the 204 URL over a blank view.
    browserManager.setPanelBounds({ sessionId: 'fresh', bounds });
    browserManager.open({ sessionId: 'fresh', initialUrl: 'about:blank' });
    browserManager.navigate({ sessionId: 'fresh', url: `http://127.0.0.1:${server.address().port}/no-content` });
    for (let i = 0; i < 150; i++) {
      const tab = browserManager.getState({ sessionId: 'fresh' }).tabs[0];
      if (!tab.isLoading && tab.url === 'about:blank') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(browserManager.getState({ sessionId: 'fresh' }).tabs[0].url, 'about:blank', 'fresh-tab 204 returns to the start page');
    assert.equal([...browserManager.runtimes.values()].find(r => r.sessionId === 'fresh').pendingUrl, null);
    browserManager.close({ sessionId: 'fresh' });

    browserManager.setPanelBounds({ sessionId: 'qa', bounds });
    browserManager.open({ sessionId: 'qa', initialUrl: 'about:blank' });


    const target = `http://127.0.0.1:${server.address().port}/newbie-tutorials/how-to-talk-to-ai/`;
    const urls = [];
    browserManager.subscribe(state => {
      const tab = state.tabs.find(item => item.id === state.activeTabId);
      urls.push({ url: tab?.url, title: tab?.title, loading: tab?.isLoading, error: tab?.lastError });
    });
    browserManager.navigate({ sessionId: 'qa', url: target });

    for (let i = 0; i < 300 && !urls.some(item => item.title === 'Fixture page' && !item.loading); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(urls.some(item => item.loading), 'observed the in-flight load');
    const reverted = urls.filter(item => item.url !== target);
    assert.deepEqual(reverted, [], 'tab URL left the target during load: ' + JSON.stringify(urls));
    const last = urls.at(-1);
    assert.equal(last.url, target);
    assert.equal(last.title, 'Fixture page');
    assert.equal(last.loading, false);
    const activeTab = () => browserManager.getState({ sessionId: 'qa' }).tabs[0];
    const runtime = () => [...browserManager.runtimes.values()][0];
    const settle = async (done, label) => {
      for (let i = 0; i < 300; i++) { if (done(activeTab())) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw Error('Timed out: ' + label + ' ' + JSON.stringify(activeTab()));
    };

    // Page to page: the address follows the new target, then the new commit.
    const second = target.replace('/newbie-tutorials/how-to-talk-to-ai/', '/second');
    urls.length = 0;
    browserManager.navigate({ sessionId: 'qa', url: second });
    await settle(tab => tab.title === 'Second page' && !tab.isLoading, 'second page');
    assert.deepEqual(urls.filter(item => item.url !== second), [], 'page-to-page navigation stays on its target');
    assert.equal(runtime().pendingUrl, null);

    // No commit at all (204): the target is dropped and the tab reports the page it is still on.
    browserManager.navigate({ sessionId: 'qa', url: target.replace('/newbie-tutorials/how-to-talk-to-ai/', '/no-content') });
    await settle(tab => !tab.isLoading && runtime().pendingUrl == null, '204 settles');
    browserManager.reload({ sessionId: 'qa' });
    await settle(tab => tab.url === second && !tab.isLoading, '204 leaves the committed page in place');

    // Failure: pending is released, the tab stays on the failed target, and
    // the error survives Chromium finishing its blank error page.
    const dead = 'http://127.0.0.1:1/unreachable';
    browserManager.navigate({ sessionId: 'qa', url: dead });
    await settle(tab => !tab.isLoading && tab.lastError, 'load failure');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(activeTab().url, dead);
    assert.ok(activeTab().lastError, 'the load error stays visible');
    assert.equal(runtime().pendingUrl, null, 'failure releases the pending target');

    // "Try again" while the panel shows its error page (native view detached):
    // the same URL must really load again, clearing the error while it runs.
    browserManager.hide({ sessionId: 'qa' });
    urls.length = 0;
    browserManager.navigate({ sessionId: 'qa', url: dead });
    await settle(tab => !tab.isLoading && tab.lastError && urls.some(item => item.loading), 'retry reloads');
    assert.ok(urls.some(item => item.loading && !item.error), 'retry clears the error while loading');
    browserManager.setPanelBounds({ sessionId: 'qa', bounds });

    // A later successful navigation clears the error.
    browserManager.navigate({ sessionId: 'qa', url: second });
    await settle(tab => tab.title === 'Second page' && !tab.isLoading, 'recover after failure');
    assert.equal(activeTab().lastError, null, 'a new page clears the old error');
    // The real start page: the panel hides the native view (start page is a
    // React surface), the user picks a recent page, and the panel re-shows the
    // view once the tab URL is no longer about:blank.
    browserManager.navigate({ sessionId: 'qa', url: 'about:blank' });
    await settle(tab => tab.url === 'about:blank' && !tab.isLoading, 'back on the start page');
    browserManager.hide({ sessionId: 'qa' });
    urls.length = 0;
    browserManager.navigate({ sessionId: 'qa', url: target });
    browserManager.setPanelBounds({ sessionId: 'qa', bounds });
    await settle(tab => tab.title === 'Fixture page' && !tab.isLoading, 'start-page pick loads while hidden');
    assert.deepEqual(urls.filter(item => item.url !== target), [], 'start-page pick never snaps back: ' + JSON.stringify(urls));
    // Live resize: a page already on screen only moves; no state re-broadcast.
    const view = runtime().view;
    assert.ok(win.contentView.children.includes(view), 'page is attached');
    let emitted = 0;
    const stopCounting = browserManager.subscribe(() => { emitted += 1; });
    for (const width of [560, 520, 480]) {
      browserManager.setPanelBounds({ sessionId: 'qa', bounds: { ...bounds, width } });
      assert.deepEqual(view.getBounds(), { ...bounds, width }, 'view follows each resize step');
    }
    browserManager.setPanelBounds({ sessionId: 'qa', bounds: { ...bounds, width: 480 } });
    stopCounting();
    assert.equal(emitted, 0, 'resizing does not re-broadcast browser state');

    // Another conversation's panel still takes the full path and detaches this page.
    browserManager.open({ sessionId: 'other', initialUrl: 'about:blank' });
    browserManager.setPanelBounds({ sessionId: 'other', bounds });
    assert.equal(win.contentView.children.includes(view), false, 'switching conversations detaches the previous page');
    browserManager.setPanelBounds({ sessionId: 'qa', bounds });
    assert.ok(win.contentView.children.includes(view), 'returning reattaches it');
    assert.deepEqual(view.getBounds(), bounds);
    console.log(`BROWSER_NAVIGATE_PASS new tab, page-to-page, 204, failed loads, start-page pick and live resize`);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    server.close();
    app.exit(exitCode);
  }
});

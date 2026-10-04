// Full-App browser panel persistence across a real process restart: the
// browser tab, its page URL and the page itself come back after relaunch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

module.exports = async ({ js, delay, capture, phase }) => {
  const portFile = path.join(process.env.BUBBLE_DESKTOP_QA_ROOT, 'browser-restore-port');
  const page = new http.Server((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Persisted page</title><p>persisted</p>');
  });
  const port = phase === 'seed' ? 0 : Number(fs.readFileSync(portFile, 'utf8'));
  await new Promise(resolve => page.listen(port, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${page.address().port}/kept/`;
  const until = async (expr, label) => {
    for (let i = 0; i < 200; i++) { if (await js(expr)) return; await delay(50); }
    throw Error('Timed out: ' + label + ' ' + await js('(async()=>JSON.stringify({tabs: qa.app.getState().rightUtilityTabs, active: qa.app.getState().activeRightUtilityTab, hidden: qa.app.getState().rightUtilityPanelHidden, tab: qa.browserTab && qa.browserTab(), main: (await window.electron.browser.getState({ sessionId: qa.app.getState().activeSessionId })).tabs}))()'));
  };
  try {
    await js(`(async()=>{
      const { useBrowserStateStore } = await import('/src/ui/store/useBrowserStateStore.ts');
      const sid = qa.app.getState().activeSessionId;
      qa.browserTab = () => { const s = useBrowserStateStore.getState().sessionStatesBySessionId[sid]; return s && s.tabs.find(t => t.id === s.activeTabId); };
    })()`);
    if (phase === 'seed') {
      fs.writeFileSync(portFile, String(page.address().port));
      await js(`qa.app.getState().openRightUtilityTab('browser')`);
      await until('!!document.querySelector("input[placeholder=\\"Search or enter a URL\\"]")', 'browser panel');
      await js(`(()=>{const i=document.querySelector('input[placeholder="Search or enter a URL"]');i.focus();
        const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(target)});
        i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
      await until(`qa.browserTab()?.title === 'Persisted page' && !qa.browserTab()?.isLoading`, 'page before restart');
      await delay(500);
      console.log('BROWSER_RESTORE_QA_SEEDED');
      return;
    }
    // After relaunch: the tab is restored, still showing the page, and loads it.
    await until(`qa.app.getState().rightUtilityTabs.includes('browser') && qa.app.getState().activeRightUtilityTab === 'browser'`, 'browser tab restored');
    await until('!!document.querySelector("input[placeholder=\\"Search or enter a URL\\"]")', 'browser panel restored');
    await until(`qa.browserTab()?.url === ${JSON.stringify(target)}`, 'page URL restored');
    // The relaunched panel loads the page at once. This QA module only runs
    // after startup, so its server was not listening yet: that very load
    // failed, which proves it happened. Try again once the server is up.
    await until('!!document.querySelector("[data-browser-error-page]")', 'restored page was loaded at startup');
    assert.equal(await js('document.querySelector("[data-browser-error-page] p").textContent'), target);
    await js('document.querySelector("[data-browser-error-page] button").click()');
    await until(`qa.browserTab()?.title === 'Persisted page' && !qa.browserTab()?.isLoading`, 'page reloaded after restart');
    assert.equal(await js('!!document.querySelector("[data-browser-start-page]")'), false, 'no start page after restart');
    await capture('browser-restored');
    console.log('BROWSER_RESTORE_QA_PASS');
  } finally {
    page.close();
  }
};

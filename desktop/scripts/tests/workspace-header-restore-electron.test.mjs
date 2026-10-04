import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Exercise the entire application and production storage across two processes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, 'dev-fixtures'), { recursive: true });
const tmp = await mkdtemp(path.join(root, 'dev-fixtures/header-restore-'));
// macOS /var is a symlink; keep fixture paths canonical for asset containment.
const runtime = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bubble-header-qa-')));
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=process.env.QA_ROOT;
app.setAppPath(root);
require(path.join(root,'dist-electron/electron/main.js'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,label)=>{for(let i=0;i<300;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error('Timed out: '+label);};
(async()=>{
 let win;
 try{
  await wait(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith(process.env.DEV_SERVER_URL));return !!win;},'main window');
  const js=code=>win.webContents.executeJavaScript(code,true).catch(error=>{console.error('Renderer script failed:',code);throw error;});
  await wait(async()=>{await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Skip for now"))?.click()');return js('!!document.querySelector("[data-workspace-header]")');},'full App');
  await js('(async()=>{window.qa={app:(await import("/src/ui/store/useAppStore.ts")).useAppStore,tabs:(await import("/src/ui/store/useTabsStore.ts")).useTabsStore};})()');
  await wait(()=>js('qa.app.getState().sessionsLoaded'),'session list loaded');
  const fixture=path.join(__dirname,'expected.json');
  let expected;
  if(process.env.QA_PHASE==='seed'){
   const sessions=require(path.join(root,'dist-electron/electron/libs/session-store.js'));
   const titles=['看下这项目在干嘛','整理设计参考','根据参考图重新调整桌面应用的标题栏、会话切换与工具面板，并验证重启后的布局保持一致'];
   const workspace=path.join(process.env.BUBBLE_DESKTOP_QA_ROOT,'plain-workspace');
   const repo=path.join(process.env.BUBBLE_DESKTOP_QA_ROOT,'git-workspace');
   fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(repo,{recursive:true});
   require('node:child_process').execFileSync('git',['init','-q',repo]);
   fs.writeFileSync(path.join(repo,'README.md'),'# Full view reference\n\n'+Array.from({length:16},(_,i)=>'## Section '+(i+1)+'\n\nA workspace keeps the open document, conversation history, and unsent draft while switching between split and full view. The file tree stays beside the document.\n').join('\n'));
   const git=(...args)=>require('node:child_process').execFileSync('git',['-C',repo,...args]);
   git('add','README.md');git('-c','user.name=QA','-c','user.email=qa@example.invalid','-c','commit.gpgsign=false','commit','-qm','test fixture');
   fs.appendFileSync(path.join(repo,'README.md'),'Changed after commit\n');
   if(process.env.QA_MARKDOWN==='1') {
    const markdown=fs.readFileSync(path.join(root,'scripts/tests/fixtures/markdown-live-preview.md'),'utf8');
    fs.writeFileSync(path.join(repo,'README.md'),(markdown+'\n'+fs.readFileSync(path.join(repo,'README.md'),'utf8')).replace(/\r?\n/g,'\r\n'));
    fs.writeFileSync(path.join(repo,'live-preview.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#8874c8"/><text x="20" y="58" fill="white">Bubble Preview</text></svg>');
    if(process.env.QA_MARKDOWN_MEDIA==='1') {
      fs.appendFileSync(path.join(repo,'README.md'),'\r\n'+fs.readFileSync(path.join(root,'scripts/tests/fixtures/markdown-html-preview.md'),'utf8').replace(/\r?\n/g,'\r\n'));
      fs.copyFileSync(path.join(root,'scripts/tests/fixtures/markdown-preview.mp4'),path.join(repo,'markdown-preview.mp4'));
    }
   }
   const source=path.join(workspace,'design-reference.md');fs.writeFileSync(source,'Design reference for the test');
   const ids=titles.map((title,index)=>{
    const row=sessions.createSession({title,cwd:index===2?workspace:repo,provider:'bubble'});
    sessions.addMessage(row.id,{type:'user_prompt',prompt:title,createdAt:Date.now(),attachments:index===0?[{id:'fixture-source',name:'design-reference.md',path:source,kind:'file',mimeType:'text/markdown'}]:undefined});
    sessions.addMessage(row.id,{type:'assistant',uuid:require('node:crypto').randomUUID(),message:{content:[{type:'text',text:'已完成界面检查。会话内容保存在本地，重新打开应用后仍可继续查看。'}]},createdAt:Date.now()+1});
    sessions.updateSessionStatus(row.id,'completed');return row.id;
   });
   await js('window.electron.sendClientEvent({type:"session.list"})');
   await wait(()=>js('('+JSON.stringify(ids)+').every(id=>qa.app.getState().sessions[id])'),'seeded sessions');
   await js('qa.app.getState().clearSkin();qa.app.getState().setTheme("light")');
   for(const id of ids){await js('qa.tabs.getState().openTab({kind:"chat",sessionId:'+JSON.stringify(id)+'})');await delay(350);}
   // Remove the empty startup tab using the actual tab action.
   await js('qa.tabs.getState().tabs.filter(t=>!t.view.sessionId).forEach(t=>qa.tabs.getState().closeTab(t.id))');
   expected={ids,titles,tabs:await js('qa.tabs.getState().tabs'),active:await js('qa.tabs.getState().activeTabId')};
   assert.equal(expected.tabs.length,3);
   fs.writeFileSync(fixture,JSON.stringify(expected));
  }else{
   expected=JSON.parse(fs.readFileSync(fixture,'utf8'));
   await wait(()=>js('qa.app.getState().activeSessionId==='+JSON.stringify(expected.ids[2])),'restored active session');
   assert.deepEqual(await js('qa.tabs.getState().tabs'),expected.tabs,'all tab ids, order, views and histories survive process restart');
   assert.equal(await js('qa.tabs.getState().activeTabId'),expected.active);
  }
  await wait(()=>js('document.body.innerText.includes("已完成界面检查")'),'persisted transcript');
  win.setSize(1280,820);win.show();app.focus({steal:true});win.focus();win.webContents.focus();await delay(500);
  if(process.env.QA_MARKDOWN==='1' || process.env.QA_BOARD_SIDEBAR==='1' || process.env.QA_BOARD_TABS==='1') {
   // The user may switch apps during QA; keep browser focus deterministic.
   win.webContents.debugger.attach('1.3');
   await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  }
  const layout=await js('(()=>{const h=document.querySelector("[data-workspace-header]"),t=document.querySelector(".bubble-header-title-label"),s=document.querySelector(".bubble-workspace-surface");return {headers:document.querySelectorAll("[data-workspace-header]").length,oldTabRows:document.querySelectorAll(".bubble-window-tabs").length,titleWidth:t.getBoundingClientRect().width,headerBottom:h.getBoundingClientRect().bottom,surfaceTop:s.getBoundingClientRect().top,count:document.querySelector(".bubble-tab-count")?.textContent,overflow:document.documentElement.scrollWidth>innerWidth};})()');
  assert.equal(layout.headers,1);assert.equal(layout.oldTabRows,0);assert.equal(layout.count,undefined);
  assert.ok(layout.titleWidth>380);assert.ok(layout.surfaceTop-layout.headerBottom<=2);assert.equal(layout.overflow,false);
  const capture=async name=>{if(process.env.QA_CAPTURE){fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG());}};
  await capture('header-'+process.env.QA_PHASE);
  win.setSize(760,640);await delay(200);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'narrow window does not overflow');
  assert.equal(await js('document.querySelector(".bubble-header-title-label").getBoundingClientRect().right<document.querySelector(".bubble-workspace-header-actions").getBoundingClientRect().left'),true,'long title leaves room for controls');
  win.setSize(1280,820);await delay(200);
  // Renderer input exercises layout and handlers; macOS app-region hit-testing
  // must also be verified with OS-level coordinate clicks.
  const click=async selector=>{const p=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await delay(150);};
  if(process.env.QA_BROWSER_START==='1') {
   if(process.env.QA_PHASE==='seed') await require(path.join(root,'scripts/tests/browser-start-qa.cjs'))({js,click,capture,delay,win});
   console.log('HEADER_RESTORE_PASS '+process.env.QA_PHASE);
   app.quit();return;
  }
  if(process.env.QA_BOARD_TABS==='1') {
   await require(path.join(root,'scripts/tests/kanban-tabs-qa.cjs'))({js,click,capture,delay,win,expected,fixture});
   console.log('HEADER_RESTORE_PASS '+process.env.QA_PHASE);
   app.quit();return;
  }
  if(process.env.QA_BOARD_SIDEBAR==='1') {
   const sidebarWidth=()=>js('document.querySelector(".aegis-sidebar").getBoundingClientRect().width');
   const hoverCollapsedTrigger=async expectedWidth=>{
    const selector='[data-sidebar-trigger][aria-expanded="false"]:not([inert] *)';
    const point=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    win.webContents.sendInputEvent({type:'mouseMove',...point});await delay(650);
    assert.equal(await sidebarWidth(),expectedWidth,'hover does not reserve sidebar space');
    assert.deepEqual(await js('(()=>{const p=document.querySelector("#bubble-project-sidebar");return {hidden:p.getAttribute("aria-hidden"),inert:p.inert,opacity:getComputedStyle(p).opacity,position:getComputedStyle(p).position}})()'),{hidden:'true',inert:true,opacity:'0',position:'relative'},'hover never opens a floating sidebar');
   };
   if(process.env.QA_PHASE==='seed') {
    if(process.env.QA_SIDEBAR_MOTION==='1') await require(path.join(root,'scripts/tests/sidebar-motion-qa.cjs'))({js,click,capture,delay,win});
    await js('qa.app.getState().setSidebarWidth(276);qa.app.getState().setSidebarCollapsed(false)');
    await click('[aria-label="KanBan"]');await delay(400);
    assert.equal(await sidebarWidth(),44,'board defaults to rail only');
    assert.ok(await js('document.querySelector("[aria-label=Workspaces]").getBoundingClientRect().width>0'),'workspace rail remains visible');
    assert.ok(await js('!!document.querySelector("[role=tablist]")'),'top tabs remain available');
    await hoverCollapsedTrigger(44);
    await capture('board-sidebar-collapsed');
    await click('[data-window-navigation] [aria-label="Expand sidebar"]');
    await js('qa.app.getState().setSidebarWidth(338)');await delay(400);
    assert.equal(await sidebarWidth(),382,'board sidebar opens and has its own width');
    win.webContents.sendInputEvent({type:'mouseMove',x:1100,y:500});await delay(650);
    assert.equal(await sidebarWidth(),382,'pointer leaving keeps clicked sidebar expanded');
    assert.equal(await js('document.querySelector("[data-window-navigation] [data-sidebar-trigger]").getAttribute("aria-expanded")'),'true');
    await click('[aria-label="Chats"]');await delay(400);
    assert.equal(await sidebarWidth(),320,'chat restores its previous width');
    assert.equal(await js('qa.app.getState().sidebarCollapsed'),false,'board did not change chat preference');
    await click('[aria-label="KanBan"]');await delay(400);
    assert.equal(await sidebarWidth(),382,'board remembers explicit expansion and width');
    await click('[data-window-navigation] [aria-label="Collapse sidebar"]');await delay(400);
    assert.equal(await sidebarWidth(),44,'board can collapse again');
    await hoverCollapsedTrigger(44);
    for(const width of [382,44]) {
     win.webContents.sendInputEvent({type:'keyDown',keyCode:'b',modifiers:['meta']});
     win.webContents.sendInputEvent({type:'keyUp',keyCode:'b',modifiers:['meta']});await delay(400);
     assert.equal(await sidebarWidth(),width,'keyboard toggle targets board sidebar only');
     assert.equal(await js('qa.app.getState().sidebarCollapsed'),false,'keyboard toggle preserves chat expansion');
    }
    await click('[aria-label="Chats"]');await delay(400);
    await js('qa.app.getState().setSidebarCollapsed(true);qa.tabs.getState().openTab({kind:"board",taskId:null})');await delay(400);
    assert.equal(await sidebarWidth(),44,'tab navigation also uses board preference');
    await click('[data-window-navigation] [aria-label="Expand sidebar"]');await delay(400);
    await click('[aria-label="Chats"]');await delay(400);
    assert.equal(await sidebarWidth(),44,'collapsed chat preference is also restored, keeping the rail');
    assert.ok(await js('document.querySelector("[aria-label=Workspaces]").getBoundingClientRect().width>0'),'chat keeps the workspace rail when collapsed');
    await hoverCollapsedTrigger(44);
    await capture('chat-sidebar-collapsed');
    await click('[data-window-navigation] [aria-label="Expand sidebar"]');await delay(400);
    win.webContents.sendInputEvent({type:'mouseMove',x:1100,y:500});await delay(650);
    assert.equal(await sidebarWidth(),320,'chat click expands and pointer leaving keeps it open');
    expected.tabs=await js('qa.tabs.getState().tabs');expected.active=await js('qa.tabs.getState().activeTabId');
    fs.writeFileSync(fixture,JSON.stringify(expected));
   } else {
    assert.equal(await js('qa.app.getState().sidebarWidth'),276,'chat width survives process restart');
    assert.equal(await js('qa.app.getState().boardSidebarCollapsed'),false,'board expansion survives process restart');
    assert.equal(await js('qa.app.getState().boardSidebarWidth'),338,'board width survives process restart');
    await click('[aria-label="KanBan"]');await delay(400);
    assert.equal(await sidebarWidth(),382,'restarted board restores independent expansion');
    await click('[aria-label="Chats"]');await delay(400);
    assert.equal(await sidebarWidth(),320,'restarted chat retains its own width');
    await capture('board-return-to-chat');
   }
   console.log('BOARD_SIDEBAR_PASS '+process.env.QA_PHASE);
   console.log('HEADER_RESTORE_PASS '+JSON.stringify({phase:process.env.QA_PHASE,...layout}));
   app.quit();return;
  }
  if(process.env.QA_PHASE==='restore'){
   await click('[aria-label="Open environment panel"]');
   await wait(()=>js('document.querySelector("[data-environment-summary]")?.innerText.includes("Not a Git repo")'),'non-Git state');
   await wait(()=>js('document.querySelector("[data-environment-summary]")?.innerText.includes("No running terminal processes")'),'empty processes');
   const text=await js('document.querySelector("[data-environment-summary]").innerText');
   assert.match(text,/Sources/);assert.match(text,/No attachments/);assert.doesNotMatch(text,/Open in editor|Bottom terminal/);
   await capture('environment-restored-non-git');
   await click('[aria-label="Environment options"]');
   await wait(()=>js('document.body.innerText.includes("Open in editor")'),'workspace tools in menu');
   assert.equal(await js('!!document.querySelector("[data-environment-summary]")'),true);
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(150);
   await click('[aria-label="Open environment panel"]');
   // Feed an isolated terminal-manager snapshot through the real IPC and UI.
   // Native PTY startup is outside this layout regression; it checks ownership,
   // idle/exited filtering and removal without launching a shell or an agent.
   const id=expected.ids[2];
   const manager=require(path.join(root,'dist-electron/electron/libs/terminal-runtime.js')).terminalManager;
   const records=[
    ['overview-running',{threadId:id,terminalId:'overview-running',status:'running',hasRunningSubprocess:true,agentKind:'shell',process:{pid:12345}}],
    ['overview-idle',{threadId:id,terminalId:'overview-idle',status:'running',hasRunningSubprocess:false,agentKind:'shell',process:{pid:12346}}],
    ['overview-exited',{threadId:id,terminalId:'overview-exited',status:'exited',hasRunningSubprocess:true,agentKind:'shell',process:{pid:12347}}],
   ];
   try {
    for(const [key,entry] of records)manager.sessions.set(key,entry);
    assert.equal((await js('window.electron.terminal.listProcesses('+JSON.stringify(id)+')')).length,1);
    assert.deepEqual(await js('window.electron.terminal.listProcesses('+JSON.stringify(expected.ids[0])+')'),[],'terminal processes cannot leak across conversations');
    await click('[aria-label="Open environment panel"]');
    await wait(()=>js('document.querySelector("[data-environment-summary]")?.innerText.includes("Terminal process")'),'process summary');
   } finally {for(const [key] of records)manager.sessions.delete(key);}
   await wait(()=>js('document.querySelector("[data-environment-summary]")?.innerText.includes("No running terminal processes")'),'closed process removed');
   await click('[aria-label="Open environment panel"]');
  }
  assert.equal(await js('!!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")?.startsWith("Switch open conversations"))'),false,'no conversation switcher before or after restart');
  if(process.env.QA_PHASE==='restore'){
   await click('[data-session-id="'+expected.ids[0]+'"]');
   await wait(()=>js('qa.app.getState().activeSessionId==='+JSON.stringify(expected.ids[0])),'switch conversation');
   assert.equal(await js('(()=>{const t=document.querySelector("[data-workspace-header] .bubble-header-title-label button span");return t.textContent==="看下这项目在干嘛"&&t.scrollWidth<=t.clientWidth})()'),true,'ordinary conversation titles are displayed in full');
   await capture('header-full-title');
   await click('[aria-label="Open environment panel"]');
   await wait(()=>js('document.querySelector("[data-environment-summary]")?.innerText.includes("design-reference.md")'),'persisted sources');
   await wait(()=>js('Array.from(document.querySelectorAll(".environment-summary-row")).some(e=>e.textContent.includes("Changes")&&!e.disabled)'),'Git changes enabled');
   await capture('environment-restored-git-sources');
   await click('[aria-label="Open environment panel"]');
   await click('[data-session-id="'+expected.ids[1]+'"]');
   await wait(()=>js('qa.app.getState().activeSessionId==='+JSON.stringify(expected.ids[1])),'switch conversation from sidebar');
   await capture('header-sidebar-navigation');
   const cwd=await js('qa.app.getState().sessions['+JSON.stringify(expected.ids[1])+'].cwd');
   await js('qa.app.getState().openProjectFileInRightPanel('+JSON.stringify({cwd,path:path.join(cwd,'README.md')})+')');
   await wait(()=>js('!!document.querySelector("[data-workspace-header] [data-utility-tab-kind=files]")'),'file tab in titlebar');
   await wait(()=>js('document.querySelector("[data-workspace-header] [data-utility-tab-kind=files]").textContent.includes("README.md")'),'file title loaded');
   await delay(250);
   const tabsLayout=await js('(()=>{const pane=document.querySelector("[data-right-utility-workspace]"),tools=document.querySelector(".bubble-workspace-header-tools"),tabs=document.querySelector("[data-workspace-tool-tabs]");return {tabTop:tabs.getBoundingClientRect().top,paneTop:pane.getBoundingClientRect().top,alignment:Math.abs(tools.getBoundingClientRect().left-pane.getBoundingClientRect().left),duplicate:!!pane.querySelector("[data-workspace-tool-tabs]")}})()');
   assert.equal(tabsLayout.tabTop,0);assert.ok(tabsLayout.alignment<2);assert.equal(tabsLayout.duplicate,false);
   assert.ok(await js('document.querySelector(".bubble-workspace-surface").getBoundingClientRect().width-document.querySelector("[data-right-utility-workspace]").getBoundingClientRect().width>=350'),'opening the pane after onboarding still reserves room for chat');
   await capture('file-tabs-titlebar');
   if(process.env.QA_MARKDOWN==='1') {
    app.focus({steal:true});win.focus();win.webContents.focus();
    await wait(()=>js('!!document.querySelector("[data-markdown-editor-mode=live] .cm-editor")'),'editable markdown preview');
    await js('(async()=>{const {EditorView}=await import("/node_modules/@codemirror/view/dist/index.js");qa.md=EditorView.findFromDOM(document.querySelector("[data-markdown-editor-mode] .cm-editor"));qa.mdOriginal=qa.md;})()');
    assert.ok(await js('!!qa.md'),'real CodeMirror view');
    const original=fs.readFileSync(path.join(cwd,'README.md'),'utf8');
    assert.equal(await js('qa.md.state.sliceDoc()'),original,'opening preserves source bytes');
    await js('qa.md.focus();qa.md.dispatch({selection:{anchor:qa.md.state.doc.toString().indexOf("**Bold")+3}})');
    await wait(()=>js('document.querySelector(".cm-content").textContent.includes("**Bold")'),'format markers reveal under caret');
    await js('qa.md.contentDOM.blur()');
    await wait(()=>js('!document.querySelector(".cm-content").textContent.includes("**Bold")'),'format markers hide on blur');
    assert.ok(await js('!!document.querySelector(".bubble-md-table-cell .aegis-cm-strong, .bubble-md-table-cell.aegis-cm-strong, .aegis-cm-strong .bubble-md-table-cell")'),'table cells preserve inline formatting');
    assert.ok(await js('!!document.querySelector(".aegis-cm-strong .aegis-cm-emphasis") || !!document.querySelector(".aegis-cm-emphasis .aegis-cm-strong")'),'nested emphasis renders');
    assert.ok(await js('document.querySelector(".bubble-md-code-line:not(.is-first):not(.is-last)").textContent.includes("**this stays literal**")'),'fenced code remains literal');
    await js('document.querySelector(".aegis-md-main").scrollTop=650');
    await wait(()=>js('!!document.querySelector(".bubble-md-math .katex")'),'math rendering');
    await wait(()=>js('!!document.querySelector(".bubble-md-mermaid svg")'),'Mermaid rendering');
    await js('qa.md.dispatch({selection:{anchor:qa.md.state.doc.toString().indexOf("Live edit target")+16}});qa.md.focus()');
    win.webContents.insertText(' 中文实时编辑');
    await wait(()=>fs.readFileSync(path.join(cwd,'README.md'),'utf8').includes('中文实时编辑'),'live edit auto-saved to disk');
    assert.equal(/(^|[^\r])\n/.test(fs.readFileSync(path.join(cwd,'README.md'),'utf8')),false,'editing preserves CRLF line endings');
    await click('.aegis-markdown-source-toggle');
    assert.equal(await js('document.querySelector("[data-markdown-editor-mode]").dataset.markdownEditorMode'),'source');
    assert.ok(await js('document.querySelector(".cm-content").textContent.includes("**Bold")'),'source shows markers');
    await click('.aegis-markdown-source-toggle');
    assert.equal(await js('document.querySelector("[data-markdown-editor-mode]").dataset.markdownEditorMode'),'live');
    await js('qa.md.focus()');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'z',modifiers:['meta']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'z',modifiers:['meta']});
    await wait(()=>!fs.readFileSync(path.join(cwd,'README.md'),'utf8').includes('中文实时编辑'),'undo after source switch is saved');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'z',modifiers:['meta','shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'z',modifiers:['meta','shift']});
    await wait(()=>fs.readFileSync(path.join(cwd,'README.md'),'utf8').includes('中文实时编辑'),'redo after source switch');
    await js('qa.md.contentDOM.blur();document.querySelector(".aegis-md-main").scrollTop=0');
    await capture('markdown-live-preview');
    console.log('MARKDOWN_LIVE_PASS: nested syntax, tables, code, math, Mermaid, Chinese input, actual disk autosave, source toggle, undo/redo');
   }

   // Real App full view: tool, conversation tab, optional floating chat, split.
   await js('qa.editor=document.querySelector("[data-chat-pane-active=true] [contenteditable=true]");qa.editor.focus()');
   win.webContents.insertText('保留这段未发送的草稿');await delay(150);
   await js('qa.filePanel=document.querySelector(".aegis-project-panel:not(.hidden)");qa.splitWidth=document.querySelector("[data-right-utility-workspace]").getBoundingClientRect().width');
   await click('[data-workspace-header] [aria-label="Enter fullscreen"]');
   await wait(()=>js('!!document.querySelector("[data-floating-chat-launcher]")'),'collapsed chat launcher');
   assert.equal(await js('document.querySelector("[data-floating-chat]").getBoundingClientRect().height'),0,'composer is hidden by default in full view');
   assert.equal(await js('!!document.querySelector("[aria-label^=Return]")'),false,'no duplicate Chat label');
   assert.ok(await js('Math.abs(document.querySelector("[data-right-utility-workspace]").getBoundingClientRect().width-document.querySelector(".bubble-workspace-surface").getBoundingClientRect().width)<=2'),'full view fills workspace');
   assert.ok(await js('Math.abs(document.querySelector("[data-utility-pane-content]").getBoundingClientRect().width-document.querySelector(".bubble-workspace-surface").getBoundingClientRect().width)<=2'),'file content also fills workspace');
   if(process.env.QA_MARKDOWN==='1') {
    if(process.env.QA_MARKDOWN_MEDIA==='1') {
     const outlineBounds=await js('(()=>{const pane=document.querySelector(".aegis-md-viewport").getBoundingClientRect(),rail=document.querySelector("[aria-label=\\"Document outline\\"]").getBoundingClientRect();return {left:rail.left-pane.left,center:(rail.top+rail.bottom-pane.top-pane.bottom)/2};})()');
     assert.ok(Math.abs(outlineBounds.left-6)<1 && Math.abs(outlineBounds.center)<1,'Markdown outline shares chat left inset and vertical centering: '+JSON.stringify(outlineBounds));
     const outlineHover=await js('(()=>{const tick=document.querySelector("[aria-label=\\"Document outline\\"] [data-outline-tick]"),r=tick.getBoundingClientRect();return {x:Math.round(r.left+8),y:Math.round(r.top+r.height/2)};})()');
     win.webContents.sendInputEvent({type:'mouseMove',...outlineHover});await delay(400);
     assert.ok(await js('document.querySelector("[data-outline-preview]")?.dataset.state==="open"'),'Markdown outline opens on native hover');
     await capture('markdown-outline-left-hover');
     win.webContents.sendInputEvent({type:'mouseMove',x:650,y:70});await delay(300);
     await js('qa.scrollMarkdown=async needle=>{const pos=qa.md.state.doc.toString().indexOf(needle),main=document.querySelector(".aegis-md-main");for(let i=0;i<3;i++){main.scrollTop+=qa.md.contentDOM.getBoundingClientRect().top+qa.md.lineBlockAt(pos).top-main.getBoundingClientRect().top-50;await new Promise(r=>setTimeout(r,150));}};qa.md.contentDOM.blur();qa.scrollMarkdown("HTML media preview")');
     await js('qa.scrollMarkdown("![Local image]")');
     await wait(()=>js('document.querySelector(".aegis-cm-image-widget img")?.naturalWidth>0'),'image decoded');
     await js('qa.image=document.querySelector(".aegis-cm-image-widget img");qa.image.scrollIntoView({block:"center"});qa.imageSelection=qa.md.state.selection.main.head;qa.imageScroll=document.querySelector(".aegis-md-main").scrollTop;qa.imageHeight=qa.image.getBoundingClientRect().height');
     await click('.aegis-cm-image-widget img');
     assert.equal(await js('qa.md.state.selection.main.head'),await js('qa.imageSelection'),'clicking the image does not move the caret');
     await click('.aegis-cm-image-widget .bubble-md-image-edit');await delay(150);
     assert.ok(await js('qa.md.state.doc.lineAt(qa.md.state.selection.main.head).text.includes("![Local image]")'),'image source button reveals the correct source');
     assert.ok(await js('qa.image===document.querySelector(".aegis-cm-image-widget img") && qa.image.getBoundingClientRect().height===qa.imageHeight'),'image stays mounted at the same height during source editing');
     assert.ok(await js('Math.abs(document.querySelector(".aegis-md-main").scrollTop-qa.imageScroll)<50'),'image editing does not center-scroll the document');
     await js('qa.md.contentDOM.blur()');await delay(100);
     assert.ok(await js('qa.image.isConnected && document.querySelector(".cm-content").textContent.includes("![Local image]")'),'focus loss does not collapse media source');
     await capture('markdown-image-source-stable');
     await js('qa.scrollMarkdown("HTML media preview")');
     await wait(()=>js('Array.from(document.querySelectorAll(".bubble-md-underline")).some(e=>e.textContent==="Grok Bot")'),'underline rendered');
     assert.ok(await js('Array.from(document.querySelectorAll(".bubble-md-underline")).every(e=>getComputedStyle(e).textDecorationLine.includes("underline"))'),'underline CSS applied');
     assert.ok(await js('document.querySelector(".cm-content").textContent.includes("<u>keep these tags</u>")'),'inline code stays literal');
     const videoSelector='.bubble-md-video-widget video[aria-label="HTML video"]';
     await wait(()=>js('document.querySelector('+JSON.stringify(videoSelector)+')?.readyState>=1'),'local video metadata decoded');
     await js('(async()=>{qa.video=document.querySelector('+JSON.stringify(videoSelector)+');qa.video.scrollIntoView({block:"center"});await qa.video.play()})()');
     await wait(()=>js('qa.video.currentTime>0.15 && !qa.video.paused'),'video actually plays');
     assert.ok(await js('qa.video.isConnected && !!document.querySelector(".bubble-md-video-widget")'),'playback does not reveal source');
     await js('qa.video.pause();qa.videoTime=qa.video.currentTime;qa.videoHeight=qa.video.getBoundingClientRect().height;qa.videoScroll=document.querySelector(".aegis-md-main").scrollTop');await capture('markdown-underline-video');
     app.focus({steal:true});win.focus();win.webContents.focus();
     await click('.bubble-md-video-widget:has(video[aria-label="HTML video"]) .bubble-md-video-edit');
     await wait(()=>js('qa.md.hasFocus && qa.md.state.doc.lineAt(qa.md.state.selection.main.from).text.includes("<video src=")'),'edit video source enters correct range');
     assert.ok(await js('qa.video===document.querySelector('+JSON.stringify(videoSelector)+') && qa.video.currentTime===qa.videoTime && qa.video.getBoundingClientRect().height===qa.videoHeight'),'source editing keeps the same video and playback position');
     assert.ok(await js('Math.abs(document.querySelector(".aegis-md-main").scrollTop-qa.videoScroll)<50'),'video editing does not center-scroll the document');
     await capture('markdown-video-source-stable');
     await js('qa.md.dispatch({changes:{from:0,insert:"\\n"}})');await delay(100);
     assert.ok(await js('qa.video===document.querySelector('+JSON.stringify(videoSelector)+') && qa.video.currentTime===qa.videoTime'),'editing before video preserves its DOM and playback position');
     await click('.bubble-md-video-widget:has(video[aria-label="HTML video"]) .bubble-md-video-edit');
     assert.ok(await js('qa.md.state.doc.lineAt(qa.md.state.selection.main.head).text.includes("<video src=")'),'source button follows mapped position after earlier edits');
     await js('qa.md.dispatch({changes:{from:0,to:1}})');
     await js('qa.md.contentDOM.blur()');
     assert.ok(await js('qa.video===document.querySelector('+JSON.stringify(videoSelector)+') && document.querySelector(".cm-content").textContent.includes("<video src=")'),'blur preserves video and its source');
     console.log('MARKDOWN_MEDIA_STABILITY_PASS: native image/source clicks, focus changes, stable scroll and dimensions, preserved video DOM/time after preceding edits');
     for(const label of ['Source child video','Markdown video','Obsidian video']) {
      await js('qa.scrollMarkdown('+JSON.stringify(label)+')');
      await wait(()=>js('document.querySelector('+JSON.stringify('.bubble-md-video-widget video[aria-label="'+label+'"]')+')?.readyState>=1'),'decoded '+label);
     }
     const pressArrow=async key=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await delay(120);};
     for(const [source,selector] of [
      ['![Local image](./live-preview.svg)', '.aegis-cm-image-widget img[alt="Local image"]'],
      ['![Markdown video](./markdown-preview.mp4)', '.bubble-md-video-widget video[aria-label="Markdown video"]'],
      ['![[markdown-preview.mp4|Obsidian video]]', '.bubble-md-video-widget video[aria-label="Obsidian video"]'],
      ['![[live-preview.svg|Obsidian image]]', '.aegis-cm-image-widget img[alt="Obsidian image"]'],
      ['<video src="./markdown-preview.mp4" poster="./live-preview.svg" controls title="HTML video"></video>', '.bubble-md-video-widget video[aria-label="HTML video"]'],
      ['<video controls title="Source child video">\n  <source src="./markdown-preview.mp4" type="video/mp4">\n</video>', '.bubble-md-video-widget video[aria-label="Source child video"]'],
     ]) {
      await js('qa.scrollMarkdown('+JSON.stringify(source)+')');
      await js('qa.arrowFrom=qa.md.state.doc.toString().indexOf('+JSON.stringify(source)+');qa.arrowTo=qa.arrowFrom+'+source.length+';qa.md.dispatch({selection:{anchor:qa.md.state.doc.line(qa.md.state.doc.lineAt(qa.arrowFrom).number-1).from}});qa.md.focus()');
      await delay(150);
      await js('qa.arrowMedia=document.querySelector('+JSON.stringify(selector)+');qa.arrowSource=qa.md.state.sliceDoc()');
      assert.ok(await js('!!qa.arrowMedia'),'media available for keyboard test: '+source);
      await js('(async()=>{if(qa.arrowMedia.tagName==="VIDEO"){qa.arrowMedia.loop=true;await qa.arrowMedia.play();}})()');
      await pressArrow('Down');
      assert.ok(await js('qa.md.state.selection.main.head>=qa.arrowFrom && qa.md.state.selection.main.head<=qa.arrowTo'),'Down enters media source: '+source);
      assert.ok(await js('qa.arrowMedia===document.querySelector('+JSON.stringify(selector)+')'),'Down preserves preview node: '+source);
      if(await js('Math.abs(qa.md.coordsAtPos(qa.arrowTo).top-qa.md.coordsAtPos(qa.arrowFrom).top)>2')) {
       await pressArrow('Down');
       assert.ok(await js('qa.md.state.selection.main.head>qa.arrowFrom && qa.md.state.selection.main.head<=qa.arrowTo'),'Down moves within wrapped/multiline source before leaving media: '+source);
      }
      for(let step=0;step<20 && await js('qa.md.state.selection.main.head<=qa.arrowTo');step++) await pressArrow('Down');
      assert.ok(await js('qa.md.state.selection.main.head>qa.arrowTo'),'Down exits below media: '+source);
      await pressArrow('Up');
      assert.ok(await js('qa.md.state.selection.main.head>=qa.arrowFrom && qa.md.state.selection.main.head<=qa.arrowTo'),'Up returns into media source: '+source);
      for(let step=0;step<20 && await js('qa.md.state.selection.main.head>=qa.arrowFrom');step++) await pressArrow('Up');
      assert.ok(await js('qa.md.state.selection.main.head<qa.arrowFrom'),'Up exits above media: '+source);
      assert.ok(await js('qa.arrowMedia===document.querySelector('+JSON.stringify(selector)+') && (qa.arrowMedia.tagName!=="VIDEO" || !qa.arrowMedia.paused)'),'keyboard navigation preserves media and running playback: '+source);
      await js('if(qa.arrowMedia.tagName==="VIDEO")qa.arrowMedia.pause()');
      assert.equal(await js('qa.md.state.sliceDoc()'),await js('qa.arrowSource'),'navigation never modifies Markdown');
     }
     await capture('markdown-media-keyboard-navigation');
     console.log('MARKDOWN_MEDIA_KEYBOARD_PASS: native Up/Down traverses Markdown/wiki images and videos, wrapped/multiline HTML, preserving preview, playback and document bytes');
     for(const width of [1280,1896,1000]) {
      win.setSize(width,820);await delay(200);
      for(const needle of ['After Markdown video first line','你也可以在 Slack','Wrapped paragraph after video','After Obsidian video first line']) {
       await js('qa.scrollMarkdown('+JSON.stringify(needle)+')');
       await js('Array.from(document.querySelectorAll(".cm-line")).find(e=>e.textContent.includes('+JSON.stringify(needle)+')).scrollIntoView({block:"center"})');await delay(150);
       for(const atEnd of [false,true]) {
        const point=await js('(()=>{const line=Array.from(document.querySelectorAll(".cm-line")).find(e=>e.textContent.includes('+JSON.stringify(needle)+')),walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT),texts=[];let n;while(n=walker.nextNode())texts.push(n);const t=texts['+(atEnd?'texts.length-1':'0')+'],offset='+(atEnd?'Math.max(0,t.length-3)':'Math.min(3,t.length-1)')+',r=document.createRange();r.setStart(t,offset);r.setEnd(t,offset+1);const b=r.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),expected:line.textContent};})()');
        app.focus({steal:true});win.focus();win.webContents.focus();
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:point.x,y:point.y});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x,y:point.y});await delay(150);
        const landed=await js('({line:qa.md.state.doc.lineAt(qa.md.state.selection.main.head).text,caret:qa.md.coordsAtPos(qa.md.state.selection.main.head)})');
        assert.ok(landed.line.includes(needle),'native click after video lands in intended source line: '+JSON.stringify({width,needle,point,landed}));
        assert.ok(landed.caret && point.y>=landed.caret.top-2 && point.y<=landed.caret.bottom+2,'caret remains on clicked visual line: '+JSON.stringify({width,needle,point,landed}));
       }
       if(width===1280 && needle==='After Markdown video first line') await capture('markdown-video-caret-fixed');
      }
     }
     win.setSize(1280,820);await delay(200);
     console.log('MARKDOWN_VIDEO_CARET_PASS: native clicks at both ends of paragraphs after Markdown/wiki videos, wrapped lines, three window widths');
     assert.ok(await js('qa.md.state.sliceDoc().includes("<u>Grok Bot</u>")'),'preview preserves underline source');
     await js('qa.scrollMarkdown("HTML media preview")');
     app.focus({steal:true});win.focus();win.webContents.focus();await delay(150);
     await js('qa.md.dispatch({selection:{anchor:qa.md.state.doc.toString().indexOf("Grok Bot")+4}});qa.md.focus()');
     await wait(()=>js('document.querySelector(".cm-content").textContent.includes("<u>Grok Bot</u>")'),'underline source reveals under caret');
     await win.webContents.insertText('edit');
     await wait(()=>fs.readFileSync(path.join(cwd,'README.md'),'utf8').includes('<u>Grokedit Bot</u>'),'underline editing saves original tags');
     await js('qa.md.contentDOM.blur()');
     console.log('MARKDOWN_HTML_MEDIA_PASS: underline render/edit/save, literal code, HTML/source/Markdown videos decoded, playback, source editing');
    }
    await js('document.querySelector(".aegis-md-main").scrollTop=0');await delay(200);
    await capture('markdown-live-full-view');
    await click('.aegis-markdown-source-toggle');await capture('markdown-source-full-view');
    await click('.aegis-markdown-source-toggle');
   }
   await js('qa.fileScroll=Array.from(qa.filePanel.querySelectorAll("div")).find(e=>e.scrollHeight>e.clientHeight+200 && getComputedStyle(e).overflowY==="auto");qa.fileScroll.scrollTop=240');
   await capture('full-view-file');
   await click('[aria-label="Open floating chat"]');
   await wait(()=>js('document.querySelector("[data-floating-chat]").getBoundingClientRect().height>400'),'floating conversation expanded');
   assert.ok(await js('document.querySelector("[data-floating-chat] [data-chat-transcript]").getBoundingClientRect().height>100'),'floating chat contains history');
   assert.equal(await js('document.querySelector("[data-floating-chat] [contenteditable=true]")===qa.editor'),true,'same mounted editor');
   assert.ok(await js('qa.editor.innerText.includes("保留这段未发送的草稿")'),'draft preserved in floating chat');
   await capture('full-view-floating-chat');
   await click('[aria-label="Minimize chat"]');
   await click('[aria-label="Show conversation"]');
   assert.equal(await js('qa.app.getState().rightPanelFullscreen'),'files','chat tab keeps full-view mode');
   assert.equal(await js('getComputedStyle(document.querySelector("[data-right-utility-workspace]")).visibility'),'hidden');
   assert.ok(await js('document.querySelector("[data-chat-transcript]").getBoundingClientRect().width>900'),'conversation fills workspace');
   await capture('full-view-conversation');
   await click('[data-utility-tab-kind="files"]');
   await wait(()=>js('getComputedStyle(document.querySelector("[data-right-utility-workspace]")).visibility==="visible"'),'return to full file');
   assert.equal(await js('document.querySelector(".aegis-project-panel:not(.hidden)")===qa.filePanel'),true,'file panel keeps identity');
   assert.equal(await js('qa.fileScroll.scrollTop'),240,'file scroll survives chat tab switch');
   await click('[aria-label="Open floating chat"]');
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(100);
   assert.equal(await js('qa.app.getState().rightPanelFullscreen'),'files','Escape minimizes floating chat first');
   await click('[data-workspace-header] [aria-label="Exit fullscreen"]');await delay(150);
   assert.ok(await js('Math.abs(document.querySelector("[data-right-utility-workspace]").getBoundingClientRect().width-qa.splitWidth)<2'),'split width restored');
   assert.ok(await js('qa.editor.innerText.includes("保留这段未发送的草稿")'),'draft survives full cycle');
   await capture('full-view-return-to-split');
   await click('[aria-label="Close README.md"]');
   await wait(()=>js('!document.querySelector("[data-workspace-header] [data-utility-tab-kind=files]")'),'close top file tab');
  }
  console.log('HEADER_RESTORE_PASS '+JSON.stringify({phase:process.env.QA_PHASE,...layout}));
  app.quit();
 }catch(e){console.error(e);if(win&&!win.isDestroyed()){fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());}app.exit(1);}
})();
`;
let server;
let passed=false;
try {
  await writeFile(path.join(tmp,'main.cjs'),main);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(tmp,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false}});
  await server.listen();
  for(const phase of ['seed','restore']) {
    await new Promise((resolve,reject)=>{
      const env={...process.env,QA_ROOT:root,QA_PHASE:phase,BUBBLE_DESKTOP_PROFILE:'qa',BUBBLE_DESKTOP_QA_ROOT:runtime,BUBBLE_DESKTOP_DEV_SERVER:'1',DEV_SERVER_URL:server.resolvedUrls.local[0]};
      for(const key of ['ELECTRON_RUN_AS_NODE','BUBBLE_HOME','BUBBLE_DEV','BUBBLE_DESKTOP_USER_DATA','AEGIS_USER_DATA_DIR'])delete env[key];
      const child=spawn(process.env.BUBBLE_DESKTOP_ELECTRON||path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',c=>{output+=c;process.stdout.write(c);});child.stderr.on('data',c=>process.stderr.write(c));
      const timeout=setTimeout(()=>{child.kill();reject(Error('Timed out '+phase));},120000);
      child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0&&output.includes('HEADER_RESTORE_PASS')?resolve():reject(Error('Failed '+phase+': '+code));});
    });
  }
  passed=true;
  console.log('Workspace header full-App process restart regression passed');
} finally {
  await server?.close();
  if(passed){await rm(tmp,{recursive:true,force:true});await rm(runtime,{recursive:true,force:true});}else console.error('Failure artifacts:',tmp);
}

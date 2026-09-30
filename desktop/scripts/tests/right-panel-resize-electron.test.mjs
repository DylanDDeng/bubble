import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/panel-resize-'));
const runtime = await mkdtemp(path.join(os.tmpdir(), 'bubble-panel-resize-'));
const harness = `
import React,{useState,useLayoutEffect,useRef,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {AnimatePresence} from 'motion/react';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {RightUtilityWorkspace} from '/src/ui/App';
import {BrowserPanel} from '/src/ui/components/browser/BrowserPanel';
import {BrowserNativeOverlayContext} from '/src/ui/components/browser/browser-native-overlay';
import {FullViewChatRegion} from '/src/ui/components/FullViewChatRegion';
import {WorkspaceHeader} from '/src/ui/components/WorkspaceHeader';
import {EnvironmentHub} from '/src/ui/components/environment/EnvironmentHub';
import {getDockedRightPanelMaxWidth,resolveDockedRightPanelWidth} from '/src/ui/utils/right-panel-width';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import '/src/ui/index.css';
window.qa={commits:[],renders:0,observedWidths:[],prefs:useAppPreferences};
window.electron={designMode:{onEvent:()=>()=>{}},browser:{
 open:async()=>({sessionId:'resize-qa',open:true,activeTabId:'tab',tabs:[{id:'tab',url:'https://resize.test',title:'Resize QA',status:'ready'}],lastError:null,agentActive:false}),
 onState:()=>()=>{},onSendSelection:()=>()=>{},hide:window.qaNative.hide,setPanelBounds:window.qaNative.setPanelBounds,
}};
qa.pointerEvents=[];for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'])window.addEventListener(type,e=>qa.pointerEvents.push({type,id:e.pointerId,buttons:e.buttons,x:e.clientX}),true);
function Harness(){
 const [headerTarget,setHeaderTarget]=useState(null);
 const [overlays,setOverlays]=useState(new Set());
 const setOverlayOpen=useCallback((id,open)=>setOverlays(current=>{if(current.has(id)===open)return current;const next=new Set(current);if(open)next.add(id);else next.delete(id);return next;}),[]);
 const [preferred,setPreferred]=useState(1200),[available,setAvailable]=useState(1000);
 const [hidden,setHidden]=useState(false),[fullscreen,setFullscreen]=useState(false),[mounted,setMounted]=useState(true);
 const [instant,setInstant]=useState(true);
 const [native,setNative]=useState(false),[dockHeight,setDockHeight]=useState(0);
 const content=useRef(null);
 Object.assign(qa,{setAvailable,setPreferred,setHidden,setFullscreen,setMounted,setInstant,setNative,preferred});qa.renders++;
 useLayoutEffect(()=>{if(!content.current)return;const ro=new ResizeObserver(e=>qa.observedWidths.push(e[0].contentRect.width));ro.observe(content.current);return()=>ro.disconnect();},[mounted]);
 const save=width=>{qa.commits.push(width);setPreferred(width);localStorage.setItem('cowork.rightUtilityPanelWidth',String(width));};
 return <BrowserNativeOverlayContext.Provider value={{hidden:overlays.size>0,setOverlayOpen}}><Tooltip.Provider><section style={{width:available}}><WorkspaceHeader tabSlotRef={setHeaderTarget} title="Workspace QA" actions={<button aria-label="Conversation actions">…</button>} environment={<EnvironmentHub alwaysShow context={{session:null,sessionId:null,contextKey:'qa',unavailableReason:'Choose a workspace.'}} git={{overview:{hasRepo:false,error:null},refresh:async()=>{}}} onOpenProjectPanel={()=>{}}/>} sidebarCollapsed={false} fullView={fullscreen} tabsVisible={!hidden} tabCount={1} onToggleFullView={()=>setFullscreen(!fullscreen)} onToggleTabs={()=>setHidden(!hidden)} onNewTab={()=>{}}/><div style={{position:'relative',display:'flex',height:600,width:available,background:'var(--bg-primary)',color:'var(--text-primary)',overflow:'hidden'}}>
 <FullViewChatRegion fullView={fullscreen} onHeightChange={setDockHeight}><main style={{flex:1,minWidth:0,paddingTop:80}}><div data-chat-transcript>Conversation</div><textarea aria-label="Draft" defaultValue="Keep this draft"/><span data-attachment>reference.png</span></main></FullViewChatRegion>
 <AnimatePresence>{mounted&&<RightUtilityWorkspace headerTarget={headerTarget} key="pane" hidden={hidden} instantReveal={instant} activePanel="files" tabs={[{id:'files',kind:'files',label:'Files'}]} activeTab="files" browserAvailable={false} width={resolveDockedRightPanelWidth(preferred,available)} maximumWidth={getDockedRightPanelMaxWidth(available)} resizable fullscreen={fullscreen} windowControlsInset={false} onWidthChange={save} onSelectTab={()=>{}} onCloseTab={()=>{}} onOpenTab={()=>{}} onNewTab={()=>{}} onReturnToChat={()=>setFullscreen(false)} onTogglePanel={()=>setHidden(true)} onToggleFullscreen={()=>setFullscreen(!fullscreen)}>
 {native?<BrowserPanel bottomInset={fullscreen?dockHeight:0} embedded sessionId={null} browserSessionId="resize-qa" collapsed={hidden} width={resolveDockedRightPanelWidth(preferred,available)} onWidthChange={save} isFullscreen={fullscreen} onToggleFullscreen={()=>setFullscreen(!fullscreen)}/>:<div ref={content} data-content style={{position:'absolute',inset:0}}><iframe title="Embedded content" style={{border:0,width:'100%',height:'100%'}} srcDoc="<body style='background:#edf1f8'>Embedded browser content</body>"/></div>}
 </RightUtilityWorkspace>}</AnimatePresence></div></section></Tooltip.Provider></BrowserNativeOverlayContext.Provider>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);
`;
const main = String.raw`
const {app,BrowserWindow,WebContentsView,ipcMain}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
app.setPath('userData',process.env.QA_PROFILE);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1500,height:800,show:false,webPreferences:{backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
 const nativeView=new WebContentsView({webPreferences:{backgroundThrottling:false}});win.contentView.addChildView(nativeView);nativeView.setVisible(false);
 await nativeView.webContents.loadURL('data:text/html,<body style="background:%23edf1f8;padding:32px;font-family:system-ui"><h2>Browser resize QA</h2><p>Native WebContentsView follows the panel while dragging.</p></body>');
 const bounds=[];
 ipcMain.handle('resize:bounds',(_,payload)=>{bounds.push(payload.bounds);nativeView.setBounds(payload.bounds);nativeView.setVisible(true);});
 ipcMain.handle('resize:hide',()=>nativeView.setVisible(false));
 const errors=[];
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const js=c=>win.webContents.executeJavaScript(c,true);
 const until=async(c)=>{for(let i=0;i<150;i++){if(await js(c))return;await delay(50);}throw Error('Timed out: '+c);};
 const pane='document.querySelector("[data-right-utility-workspace]")';
 const separator='document.querySelector("[role=separator]")';
 const width=()=>js(pane+'.getBoundingClientRect().width');
 const point=()=>js('(()=>{const r='+pane+'.getBoundingClientRect();return {x:Math.round(r.x-6),y:200};})()');
 let pressed=null;
 const input=async(type,x,y,button='left')=>{if(type==='mouseDown')pressed=button;if(type==='mouseUp')pressed=null;win.webContents.sendInputEvent({type,x,y,button,clickCount:1,modifiers:pressed?[pressed+'ButtonDown']:[]});await delay(35);};
 const start=async()=>{const p=await point();await input('mouseMove',p.x,p.y);await input('mouseDown',p.x,p.y);return p;};
 const stop=async p=>{await input('mouseUp',p.x,p.y);await delay(80);};
 const key=async keyCode=>{await js(separator+'.focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(80);};
 try {
  await win.loadURL(process.env.QA_URL);
  // App switches during QA must not cancel the synthetic drag sequence.
  // The explicit blur regression below still exercises cancellation.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await until('!!document.querySelector("[role=separator]")');await delay(300);
  assert.equal(await width(),648,'window cap reserves 352px for chat');
  assert.equal(await js('qa.preferred'),1200,'clamping does not overwrite saved preference');
  assert.equal(await js('document.querySelector("[data-workspace-tool-tabs]").getBoundingClientRect().top'),0,'utility tabs share the titlebar row');
  assert.equal(await js(pane+'.querySelector("[data-workspace-tool-tabs]")'),null,'no extra tab row inside the pane');
  const headerButtons=()=>js('[...document.querySelectorAll("[data-workspace-header] [role=toolbar] button")].map(b=>({label:b.getAttribute("aria-label"),x:b.getBoundingClientRect().x,y:b.getBoundingClientRect().y}))');
  const originalControls=await headerButtons();
  assert.deepEqual(originalControls.map(b=>b.label),['Conversation actions','Open environment panel','Enter fullscreen','Hide tabs']);
  assert.ok(originalControls.every(b=>b.y<40),'window controls live above content');
  await js('document.querySelector("button[title=Environment]").click()');await delay(60);
  const card=await js('document.querySelector("[data-environment-summary]").getBoundingClientRect().toJSON()');
  assert.ok(card.top>=40&&card.right<=352,'environment card stays under the conversation controls');
  await js('document.querySelector("button[title=Environment]").click()');
  const p=await point();
  assert.equal(await js('document.elementFromPoint('+p.x+','+p.y+').getAttribute("role")'),'separator','outer half of hit area is not clipped');
  let startPoint=await start();
  assert.equal(await js(pane+'.dataset.resizing'),'true');
  const renders=await js('qa.renders');
  // Shrink from a preferred width beyond the current cap, moving into the iframe.
  for(let delta=20;delta<=120;delta+=20)await input('mouseMove',startPoint.x+delta,startPoint.y);
  assert.deepEqual((await headerButtons()).slice(2),originalControls.slice(2),'fullscreen and panel toggles remain at the window edge');
  assert.ok((await headerButtons())[1].x>originalControls[1].x,'conversation controls follow the split boundary');
  assert.ok(await js('Math.abs(document.querySelector(".bubble-workspace-header-tools").getBoundingClientRect().left-'+pane+'.getBoundingClientRect().left)<2'),'tab row follows the live divider without parent renders');
  assert.equal(await width(),528,'drag starts from rendered width, not saved width');
  assert.equal(await js('qa.commits.length'),0,'no preference writes while dragging');
  assert.equal(await js('qa.renders'),renders,'live resize does not render the parent');
  assert.ok(await js('qa.observedWidths.some(w=>Math.abs(w-527)<2)'),'embedded content receives live geometry');
  await stop({x:startPoint.x+120,y:startPoint.y});
  assert.deepEqual(await js('qa.commits'),[528]);
  assert.equal(await js('localStorage.getItem("cowork.rightUtilityPanelWidth")'),'528');
  assert.equal(await js('document.body.style.cursor'),'');
  assert.equal(await js(separator+'.getAttribute("aria-valuenow")'),'528');

  // A press without movement must not rewrite a saved preference.
  startPoint=await start();await stop(startPoint);
  assert.equal(await js('qa.commits.length'),1);
  const before=await width();
  startPoint=await point();await input('mouseDown',startPoint.x,startPoint.y,'right');
  await input('mouseMove',startPoint.x+60,startPoint.y,'right');await input('mouseUp',startPoint.x+60,startPoint.y,'right');
  assert.equal(await width(),before,'right-click is not a resize');

  await key('Left');assert.equal(await width(),538);
  await key('Home');assert.equal(await width(),320);
  await key('End');assert.equal(await width(),648);
  await js('qa.setAvailable(1400)');await delay(100);
  assert.equal(await width(),648,'expanding host preserves committed width');
  await js(separator+'.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await delay(100);
  assert.equal(await width(),820,'double click resets to default');
  await key('End');assert.equal(await width(),1048,'large windows are not capped at 58 percent');

  // Cancel events carry no trustworthy position. Unrelated pointers must not end a drag.
  startPoint=await start();await input('mouseMove',startPoint.x+80,startPoint.y);
  const cancelWidth=await width(),count=await js('qa.commits.length');
  await js('window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:99}))');
  assert.equal(await js(pane+'.dataset.resizing'),'true');
  await js('window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:1}))');await delay(80);
  assert.equal(await width(),cancelWidth);
  assert.equal(await js('qa.commits.length'),count+1);
  await stop({x:startPoint.x+80,y:startPoint.y});
  assert.equal(await js('qa.commits.length'),count+1,'release after cancellation does not double-save');

  // Window changes abort a gesture; the saved preferred width survives.
  startPoint=await start();await input('mouseMove',startPoint.x+20,startPoint.y);
  const saved=await js('qa.preferred'),savedCount=await js('qa.commits.length');
  await js('qa.setAvailable(800)');await delay(100);
  await stop({x:startPoint.x+30,y:startPoint.y});
  assert.equal(await width(),448);
  assert.equal(await js('qa.preferred'),saved);
  assert.equal(await js('qa.commits.length'),savedCount);
  await js('qa.setAvailable(1400)');await delay(100);
  assert.equal(await width(),saved);

  await js('document.body.style.cursor="crosshair";document.body.style.userSelect="text"');
  startPoint=await start();await input('mouseMove',startPoint.x+20,startPoint.y);
  await js('window.dispatchEvent(new Event("blur"))');await delay(80);
  assert.equal(await js('document.body.style.cursor'),'crosshair');
  assert.equal(await js('document.body.style.userSelect'),'text');
  await stop({x:startPoint.x+20,y:startPoint.y});

  await js('qa.originalComposer=document.querySelector("textarea");qa.setFullscreen(true)');await delay(80);
  assert.equal(await width(),1400);assert.equal(await js('!!'+separator),false);
  assert.equal(await js('document.querySelector("textarea")===qa.originalComposer'),true,'full view preserves composer identity');
  assert.equal(await js('document.querySelector("textarea").value'),'Keep this draft');
  assert.equal(await js('document.querySelector("[data-full-view-chat]").getBoundingClientRect().height'),0,'full view starts with collapsed chat');
  await js('document.querySelector("[data-floating-chat-launcher]").click()');await delay(80);
  assert.ok(await js('document.querySelector("[data-chat-transcript]").getBoundingClientRect().height>0'),'expanded floating chat includes history');
  assert.equal(await js('document.querySelector("[data-attachment]").textContent'),'reference.png');
  await js('qa.setFullscreen(false)');await delay(80);
  assert.equal(await width(),await js('qa.preferred'));
  await js('qa.setInstant(false);qa.setHidden(true)');await delay(450);
  assert.equal(await width(),0);assert.equal(await js(pane+'.inert'),true);
  await js('qa.setHidden(false)');await delay(70);
  await js('qa.setHidden(true)');await delay(40);
  await js('qa.setHidden(false)');await delay(450);
  assert.equal(await width(),await js('qa.preferred'),'rapid close/open ends at the requested width');
  await js('qa.prefs.setState({reduceMotion:"on"});qa.setHidden(true)');await delay(60);
  assert.equal(await width(),0,'reduced motion skips the transition');
  await js('qa.setHidden(false)');await delay(60);
  assert.equal(await width(),await js('qa.preferred'));

  startPoint=await start();await input('mouseMove',startPoint.x+20,startPoint.y);
  const commitsBeforeUnmount=await js('qa.commits.length');
  await js('qa.setMounted(false)');await delay(120);
  assert.equal(await js('!!'+pane),false,'AnimatePresence finishes exit');
  await stop({x:startPoint.x+40,y:startPoint.y});
  assert.equal(await js('qa.commits.length'),commitsBeforeUnmount,'unmount clears the gesture');
  assert.equal(await js('document.body.style.cursor'),'crosshair');
  // Exercise the production BrowserPanel ResizeObserver and IPC path with a
  // real native view, without changing its committed width prop mid-gesture.
  win.show();
  await js('qa.setNative(true);qa.setMounted(true)');await until('!!'+separator);await delay(400);
  const nativeStart=await width(),nativeCommits=await js('qa.commits.length');
  startPoint=await start();await input('mouseMove',startPoint.x+90,startPoint.y);await delay(100);
  assert.equal(await width(),nativeStart-90);
  assert.equal(await js('qa.commits.length'),nativeCommits);
  assert.equal(nativeView.getBounds().width,Math.round(nativeStart-91),'native view tracks live DOM width before commit');
  assert.equal(nativeView.getBounds().x,Math.round(1400-(nativeStart-90)+1),'native view tracks the moving left edge');
  assert.ok(bounds.length>1);
  await stop({x:startPoint.x+90,y:startPoint.y});
  for(let i=0;i<40;i++){if(await nativeView.webContents.executeJavaScript('window.innerWidth')===nativeView.getBounds().width)break;await delay(25);}
  assert.equal(await nativeView.webContents.executeJavaScript('window.innerWidth'),nativeView.getBounds().width,'native page receives the resized viewport');
  await js('qa.setFullscreen(true)');await delay(180);
  const dockTop=await js('document.querySelector("[data-floating-chat-launcher]").getBoundingClientRect().top');
  const viewBounds=nativeView.getBounds();
  assert.ok(viewBounds.y+viewBounds.height<=dockTop,'native page cannot cover the chat launcher');
  await js('document.querySelector("[data-floating-chat-launcher]").click()');await delay(180);
  assert.equal(nativeView.getVisible(),false,'native browser yields to floating conversation');
  await js('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Minimize chat").click()');await delay(180);
  assert.equal(nativeView.getVisible(),true,'minimizing restores native browser');
  await js('qa.setFullscreen(false)');await delay(180);
  assert.equal(await js('document.querySelector("textarea").value'),'Keep this draft','returning to split retains draft');
  require('node:fs').writeFileSync(path.join(process.env.QA_CAPTURE_DIR,'bubble-panel-resize-verified.png'),(await win.webContents.capturePage()).toPNG());
  await js('qa.prefs.setState({reduceMotion:"off"});qa.setMounted(false)');await delay(450);
  assert.equal(await js('!!'+pane),false,'animated exit also removes the panel');
  assert.equal(nativeView.getVisible(),false,'closing the panel detaches the native browser');
  assert.deepEqual(errors,[]);
  console.log('right panel Electron: constrained drag, iframe crossing, deferred persistence, keyboard, cancel, window resize, fullscreen, animation, reduced motion, cleanup and native BrowserPanel bounds passed');
  app.exit(0);
 } catch(e) {console.error(e);console.error(await js('JSON.stringify({events:qa.pointerEvents,commits:qa.commits,widths:qa.observedWidths})'));app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  await writeFile(path.join(tmp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qaNative',{setPanelBounds:p=>ipcRenderer.invoke('resize:bounds',p),hide:()=>ipcRenderer.invoke('resize:hide')});`);
  server = await createServer({
    root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(tmp, 'vite-cache'),
    plugins: [{ name: 'resize-qa', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/src/ui/App.tsx')) return source + '\nexport { RightUtilityWorkspace };';
    } }],
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/.aegis-design-qa/**'] } },
  });
  await server.listen();
  const env = {
    ...process.env,
    QA_URL: new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href,
    BUBBLE_HOME: path.join(runtime, 'bubble-home'),
    QA_PROFILE: path.join(runtime, 'profile'),
    QA_CAPTURE_DIR: os.tmpdir(),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { cwd: root, env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Resize QA timed out')); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Resize QA failed: ' + code)); });
  });
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}

import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/file-tabs-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bubble-file-tabs-qa-'));
let server;
const harness=String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useAppStore} from '/src/ui/store/useAppStore';
import {ProjectTreePanel} from '/src/ui/components/ProjectTreePanel';
import {Tooltip} from '@base-ui-components/react/tooltip';
import '/src/ui/index.css';
const store=useAppStore;const root='/qa/project';
const paths=['one.md','two.md','page.html','image.svg','readonly.txt','tree-only.md','movie.mp4'];
const docs=[...Array.from({length:40},(_,i)=>'filler-'+String(i).padStart(2,'0')+'.txt'),'nested.md'];
const tree={name:'project',path:root,kind:'dir',children:[{name:'docs',path:root+'/docs',kind:'dir',children:docs.map(name=>({name,path:root+'/docs/'+name,kind:'file'}))},...paths.map(name=>({name,path:root+'/'+name,kind:'file'}))]};
const previews=[];
window.electron={getProjectTree:async()=>tree,cancelProjectTreeRead:async()=>{},watchProjectTree:async()=>true,unwatchProjectTree:async()=>{},onProjectTreeUpdated:()=>()=>{},
 readProjectFilePreview:async(cwd,p)=>{previews.push(p);const name=p.split('/').pop();const ext='.'+name.split('.').pop();const base={path:p,name,ext,size:10,mtimeMs:1};if(ext==='.mp4')return {...base,kind:'video',previewUrl:name==='broken.mp4'?'data:video/mp4;base64,AAAA':'/scripts/tests/fixtures/video-preview.mp4'};if(ext==='.svg')return {...base,kind:'image',dataUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'};return {...base,kind:ext==='.md'?'markdown':ext==='.html'?'html':'text',text:ext==='.html'?'<h1>Page</h1>':'# '+name,editable:ext==='.md'}},
 watchProjectFile:async()=>true,unwatchProjectFile:async()=>{},onProjectFileChanged:()=>()=>{},registerProjectEditor:async()=>{},unregisterProjectEditor:async()=>{},updateProjectEditorDraft:async()=>{},onProjectEditorFlushRequest:()=>()=>{},listOpenWithApps:async()=>({ok:true,apps:[]}),sendClientEvent:()=>{},
};
const session=store.getState().createDraftSession(root);store.setState({activeSessionId:session,projectTree:tree,projectTreeCwd:root});
let remount;
function Harness(){
 const s=store();const [version,setVersion]=useState(0);remount=()=>setVersion(v=>v+1);
 return <Tooltip.Provider><div><div role="tablist">{s.rightUtilityTabs.filter(t=>t.startsWith('files')).map(t=><button role="tab" aria-selected={s.activeRightUtilityTab===t} key={t} onClick={()=>s.setActiveRightUtilityTab(t)}>{s.rightPanelBySessionId[session]?.fileTabsByUtilityTab[t]?.activeFile?.filePath.split('/').pop()||'Files'}</button>)}</div><div style={{position:'relative',height:650,width:960}}>{s.rightUtilityTabs.filter(t=>t.startsWith('files')).map(t=><ProjectTreePanel key={t+version} sessionId={session} utilityTabId={t} embedded activeTab="files" collapsed={s.activeRightUtilityTab!==t} onClose={()=>s.closeRightUtilityTab(t)} onOpenFile={s.openProjectFileInRightPanel} openRequest={s.pendingProjectFileOpen?.tabId===t?s.pendingProjectFileOpen:null} onOpenRequestConsumed={s.clearPendingProjectFileOpen} sharedPanelWidth={960}/>)}</div></div></Tooltip.Provider>
}
createRoot(document.getElementById('root')).render(<Harness/>);
window.qa={store,session,previews,remount:()=>remount(),open:name=>store.getState().openProjectFileInRightPanel({cwd:root,path:root+'/'+name}),snapshot:()=>{const s=store.getState();return {tabs:s.rightUtilityTabs,active:s.activeRightUtilityTab,files:s.rightPanelBySessionId[session]?.fileTabsByUtilityTab}}};
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));app.setPath('sessionData',path.join(process.env.QA_DATA_DIR,'session-data'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{backgroundThrottling:false}});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const run=s=>w.webContents.executeJavaScript(s);const settle=()=>delay(350);
 try{
 await w.loadURL(process.env.QA_URL);for(let i=0;i<150;i++){if(await run('!!window.qa'))break;await delay(100)}
 await run("qa.open('one.md')");await settle();const first=await run('qa.snapshot()');assert.equal(first.tabs.length,1);
 await run("qa.open('two.md')");await settle();const second=await run('qa.snapshot()');assert.equal(second.tabs.length,2,'a second file must get a visible outer tab');
 assert.notEqual(first.active,second.active);assert.equal(second.files[first.active].activeFile.filePath,'/qa/project/one.md');
 await run("qa.open('one.md')");await settle();assert.equal((await run('qa.snapshot()')).active,first.active);assert.equal((await run('qa.snapshot()')).tabs.length,2);
 await run("qa.open('page.html');qa.open('image.svg');qa.open('readonly.txt')");await settle();let snapshot=await run('qa.snapshot()');assert.equal(snapshot.tabs.length,5,'rapid mixed-type opens reserve separate tabs');
 assert.equal(new Set(Object.values(snapshot.files).map(f=>f.activeFile?.filePath)).size,5);
 await run('qa.remount()');await settle();snapshot=await run('qa.snapshot()');assert.equal(snapshot.tabs.length,5,'restore retains every file type');
 assert.equal(Object.values(snapshot.files).filter(f=>f.activeFile).length,5);
 await run("qa.open('one.md')");await settle();
 const clicked=await run("(()=>{const panels=[...document.querySelectorAll('.aegis-project-panel')];const panel=panels.find(p=>p.getBoundingClientRect().width>0&&p.getBoundingClientRect().height>0&&getComputedStyle(p).display!=='none');const row=[...panel.querySelectorAll('[role=treeitem],button,div,span')].find(e=>e.textContent==='two.md'&&e.children.length===0);if(!row)return false;row.click();return true})()");
 assert(clicked,'file tree row exists');await settle();assert.equal((await run('qa.snapshot()')).active,second.active,'tree navigation reuses the matching visible tab');
 await run('qa.store.getState().closeRightUtilityTab(qa.snapshot().active)');await settle();assert.equal((await run('qa.snapshot()')).tabs.length,4);
 await run("qa.open('two.md')");await settle();assert.equal((await run('qa.snapshot()')).tabs.length,5,'closed file can reopen');
 const newTreeFile=await run("(()=>{const p=[...document.querySelectorAll('.aegis-project-panel')].find(p=>getComputedStyle(p).display!=='none'&&p.getBoundingClientRect().width>0);const row=[...p.querySelectorAll('span')].find(e=>e.textContent==='tree-only.md'&&e.children.length===0);row?.click();return !!row})()");
 assert(newTreeFile);await settle();assert.equal((await run('qa.snapshot()')).tabs.length,6,'a new tree file also gets a visible tab');
 await run("qa.open('one.md')");await settle();
 const visiblePanel="[...document.querySelectorAll('.aegis-project-panel')].find(p=>getComputedStyle(p).display!=='none'&&p.getBoundingClientRect().width>0)";
 const treeRow=name=>'[...'+visiblePanel+".querySelectorAll('span')].find(e=>e.textContent==="+JSON.stringify(name)+'&&e.children.length===0)';
 assert(await run('(()=>{const row='+treeRow('docs')+';row?.click();return !!row})()'),'folder row exists');await settle();
 const scrolled=await run('(()=>{const row='+treeRow('nested.md')+";if(!row)return -1;const scroller=row.closest('.overflow-auto');row.scrollIntoView({block:'end'});scroller.dispatchEvent(new Event('scroll'));return scroller.scrollTop})()");
 assert(scrolled>0,'tree is scrolled down to the nested file');
 const tabsBeforeNested=(await run('qa.snapshot()')).tabs.length;
 await run(treeRow('nested.md')+'.click()');await settle();
 assert.equal((await run('qa.snapshot()')).tabs.length,tabsBeforeNested+1,'nested tree file opens a new tab');
 assert(await run('!!'+treeRow('nested.md')),'new tab keeps the clicked folder expanded');
 assert.equal(await run(treeRow('nested.md')+".closest('.overflow-auto').scrollTop"),scrolled,'new tab keeps the tree scroll position');
 await run("qa.open('movie.mp4')");await settle();
 for(let i=0;i<40;i++){if(await run("document.querySelector('video')?.readyState>=2"))break;await delay(100)}
 assert.equal(await run("document.querySelector('video').videoWidth"),160,'right panel renders a real decoded MP4');
 await run("(()=>{const v=document.querySelector('video');v.muted=true;return v.play()})()");await settle();
 assert(await run("document.querySelector('video').currentTime>0"),'video advances in the file panel');
 await run("qa.open('one.md')");await settle();assert.equal(await run("document.querySelector('video').paused"),true,'hidden file tab pauses playback');
 await run("qa.open('movie.mp4')");await settle();assert.equal((await run('qa.snapshot()')).tabs.length,8,'video reopens in its existing tab');
 await run("qa.open('broken.mp4')");await settle();
 for(let i=0;i<30;i++){if(await run("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('Unable to load or decode'))"))break;await delay(100)}
 assert(await run("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('Unable to load or decode'))"),'decoder failures have an explanation');
 assert.deepEqual(errors,[]);console.log('PASS Electron file tabs: distinct files, dedupe, mixed types, rapid opens, restore, tree routing, tree state across tabs, close/reopen, MP4 playback/pause/error');app.exit(0);
 }catch(e){console.error(e,errors);app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);
 await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dataDir,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false}});
 await server.listen();
 const env={...process.env,QA_DATA_DIR:dataDir,BUBBLE_HOME:path.join(dataDir,'agent-home'),BUBBLE_DESKTOP_PROFILE:'qa',BUBBLE_DESKTOP_USER_DATA:path.join(dataDir,'profile'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'artifacts/privacy-probe')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Electron test timed out'))},120000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron test failed: '+code))});
 });
} finally { await server?.close();await rm(dir,{recursive:true,force:true});await rm(dataDir,{recursive:true,force:true}); }

import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/privacy-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bubble-privacy-qa-'));
let server;
const harness = String.raw`
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useProjectFileMentions} from '/src/ui/hooks/useProjectFileMentions';
import {useAppStore} from '/src/ui/store/useAppStore';
import {MDContent} from '/src/ui/render/markdown';
import {loadPassiveImagePreview} from '/src/ui/utils/passive-image-preview';
const reads=[], cancellations=[], previews=[], pending=[];
window.electron={
 getProjectTree:(cwd,id)=>{reads.push({cwd,id});return new Promise((resolve,reject)=>pending.push({resolve,reject}))},
 cancelProjectTreeRead:async id=>{cancellations.push(id)},
 readProjectFilePreview:async (cwd,file)=>{previews.push({cwd,file});return {kind:'error'}},sendClientEvent:()=>{},
};
const current=useAppStore.getState().createDraftSession('/qa/current');
useAppStore.getState().createDraftSession('/qa/unrelated-home');
useAppStore.setState({activeSessionId:current,projectTree:null,projectTreeCwd:null});
let edit,restore,switchCwd;
function Probe(){
 const [prompt,setPrompt]=useState('');const [cwd,setCwd]=useState('/qa/current');
 const mentions=useProjectFileMentions({cwd,prompt,cursorIndex:prompt.length});
 edit=next=>{mentions.onUserInput(next);setPrompt(next)};
 restore=next=>setPrompt(next);switchCwd=next=>setCwd(next);
 window.state={loading:mentions.loading,suggestions:mentions.suggestions,hasMentionQuery:mentions.hasMentionQuery};
 return <div><input aria-label="probe" value={prompt} onChange={e=>edit(e.target.value)}/><MDContent content="![missing](nested/missing.png)"/></div>;
}
const reactRoot=createRoot(document.getElementById('root'));reactRoot.render(<Probe/>);
window.qa={reads,cancellations,previews,pending,edit:p=>edit(p),restore:p=>restore(p),switchCwd:p=>switchCwd(p),unmount:()=>reactRoot.unmount(),loadPassiveImagePreview};
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));app.setPath('sessionData',path.join(process.env.QA_DATA_DIR,'session-data'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
 w.webContents.on('render-process-gone',(_,d)=>{console.error(d);app.exit(2)});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const run=s=>w.webContents.executeJavaScript(s);const settle=()=>delay(200);
 try{
 await w.loadURL(process.env.QA_URL);
 for(let i=0;i<200;i++){if(await run('!!window.qa && !!window.state'))break;await delay(100)}
 await delay(1000);
 assert.equal(await run('qa.reads.length'),0,'idle and missing images do not load trees');
 const previews=await run('qa.previews');assert(previews.length>0);assert(previews.every(p=>p.cwd==='/qa/current'),'no historical workspace probes');
 await run("qa.restore('@old-draft')");await settle();assert.equal(await run('qa.reads.length'),0,'restored @ draft');
 await run("qa.edit('ordinary typing')");await settle();assert.equal(await run('qa.reads.length'),0);
 await run("qa.edit('@s')");await settle();assert.equal(await run('qa.reads.length'),1);
 await run("qa.edit('@src')");await settle();assert.equal(await run('qa.reads.length'),1,'query shares scan');
 await run("qa.edit('')");await settle();assert.equal(await run('qa.cancellations.length'),1);
 await run("qa.pending[0].resolve({kind:'dir',name:'old',path:'/qa/current',children:[{kind:'file',name:'old.ts',path:'/qa/current/old.ts'}]})");await settle();assert.equal(await run('state.suggestions.length'),0,'late result');
 await run("qa.edit('@next')");await settle();assert.equal(await run('qa.reads.length'),2);
 await run("qa.switchCwd('/qa/other')");await settle();assert.equal(await run('qa.reads.length'),2,'cwd switch cannot authorize scan');
 await run("qa.edit('@new')");await settle();assert.equal(await run('qa.reads.length'),3);
 await run("qa.pending[2].reject(new Error('cancelled by host'))");await settle();assert.equal(await run('state.loading'),false);
 await run("qa.edit('')");await settle();await run("qa.edit('@file')");await settle();assert.equal(await run('qa.reads.length'),4);
 await run("qa.pending[3].resolve({kind:'dir',name:'other',path:'/qa/other',children:[{kind:'file',name:'file.ts',path:'/qa/other/file.ts'}]})");await settle();
 assert.equal(await run('state.suggestions[0].relativePath'),'file.ts');assert.equal(await run('qa.reads.length'),4,'cache does not rescan');
 const media=await run("(async()=>{let cancelled=false;let calls=0;const img=await qa.loadPassiveImagePreview({src:'image.png',roots:['/project'],cancelled:()=>false,load:async()=>({kind:'image',dataUrl:'data:image/png;base64,AA==',path:'/project/image.png'})});const video=await qa.loadPassiveImagePreview({src:'/project/video.mp4',roots:[],cancelled:()=>false,load:async()=>({kind:'video',previewUrl:'http://localhost/video',path:'/project/video.mp4'})});await qa.loadPassiveImagePreview({src:'missing.png',roots:['/one','/two'],cancelled:()=>cancelled,load:async()=>{calls++;cancelled=true;return {kind:'error'}}});return {img,video,calls}})()");
 assert.equal(media.img.kind,'image');assert.equal(media.video.kind,'video');assert.equal(media.calls,1);
 await run("qa.switchCwd('/qa/last');qa.edit('')");await settle();await run("qa.edit('@pending')");await settle();
 const before=await run('qa.cancellations.length');await run('qa.unmount()');await settle();assert.equal(await run('qa.cancellations.length'),before+1);
 assert.deepEqual(errors,[]);
 console.log('PASS isolated Electron: idle/restored drafts, lazy @ indexing, cancellation, cwd switch, rejection, cache, historical missing images, image/video previews');app.exit(0);
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

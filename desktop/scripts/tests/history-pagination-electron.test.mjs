import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qaRoot = path.join(root, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmp = await mkdtemp(path.join(qaRoot, 'history-pagination-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bubble-history-qa-'));
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from '@base-ui-components/react/tooltip';
import { ChatPane } from '/src/ui/components/ChatPane.tsx';
import { useAppStore } from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';
window.electron = { getSessionUserPrompts: async () => [], sendClientEvent: () => {}, getRecentCwds: async () => [] };
for (const provider of ['Claude','Codex','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek']) {window.electron['get'+provider+'ModelConfig'] = async () => ({defaultModel:null, options:[], availableModels:[]});}
window.electron.getClaudeCompatibleProviderConfig = async () => ({});
window.qaHistory = {calls:0};
window.electron.loadOlderSessionHistory = async (id,cursor) => {
 qaHistory.calls++; await new Promise(r=>setTimeout(r,80));if(qaHistory.fail) throw Error('QA history unavailable');const page=Number(cursor)-1;
 return {messages:page>0?[{type:'user',message:{content:[{type:'tool_result',tool_use_id:'t'+page,content:'Done'}]},createdAt:page}]:[{type:'user_prompt',prompt:'The oldest message is reachable.',createdAt:0}],cursor:String(page),hasMore:page>0};
};
const a = useAppStore.getState();
const first = a.createDraftSession('');
const second = a.createDraftSession('');
function messages(count) {return Array.from({length:count},(_,i)=>({type:'user_prompt',prompt:'Turn '+(i+1)+': Please review the latest changes and explain how the updated chat navigation behaves. Include the expected behavior when reading earlier messages.',createdAt:1000+i*1000}));}
useAppStore.setState(s=>({sessions:{...s.sessions,[first]:{...s.sessions[first],isDraft:false,hydrated:true,hasMoreHistory:true,historyCursor:'8',messages:messages(1)},[second]:{...s.sessions[second],isDraft:false,hydrated:true,messages:messages(30)}}}));
a.setActiveSession(first);
window.qa = { first, second, store:useAppStore, scroll: () => document.querySelector('[data-chat-scroll-container]') };
function Harness() {const id=useAppStore(s=>s.activeSessionId);return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)'}}><ChatPane paneId="primary" sessionId={id} isActive onActivate={()=>{}} codexModelConfig={{}} showHeader={false}/></div></Tooltip.Provider>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));
const delay = ms => new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:800,show:false});
 const errors=[]; const expectedErrors=[];
 win.webContents.on('console-message',event=>{if(event.level==='error'){if(event.message.includes('Failed to load older session history:')) expectedErrors.push(event.message);else {errors.push(event.message);console.error(event.message);}}});
 const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(e){throw new Error(code+' :: '+e.message);}};
 try {
  await win.loadURL(process.env.QA_URL);
  console.log('Loaded chat fixture');
  for(let i=0;i<150;i++){if(await js('!!window.qa && !!qa.scroll()'))break;await delay(100);}
  await delay(400);
  const wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await delay(50)}throw Error('Timed out: '+code)};
  const noButton=async()=>assert.equal(await js('document.body.innerText.includes("Load earlier messages") || document.body.innerText.includes("Loading earlier messages")'),false);
  await wait('qaHistory.calls===3 && !qa.store.getState().sessions[qa.first].loadingMoreHistory');
  await delay(200);assert.equal(await js('qaHistory.calls'),3,'background fill stays bounded');
  assert(await js('qa.scroll().scrollHeight<=qa.scroll().clientHeight+4'),'collapsed history has no scrollbar');
  await noButton();
  // A wheel inside a nested scrollable must stay inside that region.
  await js('(()=>{const box=document.createElement("div");box.id="nested-scroll";box.style.cssText="height:60px;overflow-y:auto";box.innerHTML="<div style=height:600px>Scrollable tool output</div>";qa.scroll().append(box);box.scrollTop=100;box.firstChild.dispatchEvent(new WheelEvent("wheel",{deltaY:-50,bubbles:true}))})()');
  await delay(150);assert.equal(await js('qaHistory.calls'),3,'nested scroll does not load transcript history');
  await js('document.getElementById("nested-scroll").remove()');
  await js('qa.scroll().dispatchEvent(new WheelEvent("wheel",{deltaY:-100,ctrlKey:true,bubbles:true}))');
  await delay(150);assert.equal(await js('qaHistory.calls'),3,'pinch zoom does not load history');
  await js('qa.scroll().dispatchEvent(new WheelEvent("wheel",{deltaY:100,bubbles:true}))');
  await delay(150);assert.equal(await js('qaHistory.calls'),3,'downward gesture does not load');
  await js('for(let i=0;i<5;i++)qa.scroll().dispatchEvent(new WheelEvent("wheel",{deltaY:-100,bubbles:true}))');
  assert.equal(await js('qaHistory.calls'),4,'gestures do not duplicate an in-flight request');await noButton();
  await wait('qaHistory.calls>=6 && !qa.store.getState().sessions[qa.first].loadingMoreHistory');
  await delay(200);assert.equal(await js('qaHistory.calls'),6,'gesture batch includes its first request in the three-page cap');
  await js('qa.scroll().focus();qa.scroll().dispatchEvent(new KeyboardEvent("keydown",{key:"PageUp",bubbles:true}))');
  await wait('!qa.store.getState().sessions[qa.first].hasMoreHistory');
  assert.equal(await js('qaHistory.calls'),8);
  assert(await js('document.body.innerText.includes("The oldest message is reachable.")'));await noButton();
  await js('qa.store.getState().setActiveSession(qa.second)');await delay(200);
  await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.second]:{...s.sessions[qa.second],hasMoreHistory:true,historyCursor:"1"}}}))');
  await js('qa.scroll().scrollTop=0');
  await wait('qaHistory.calls===9 && !qa.store.getState().sessions[qa.second].loadingMoreHistory');
  assert(await js('qa.scroll().scrollTop>0'),'prepend preserves scroll anchor');await noButton();
  // A failed page load stops after a bounded batch and a later gesture retries it.
  await js('qaHistory.fail=true;qa.store.getState().setActiveSession(qa.first);qa.store.setState(s=>({sessions:{...s.sessions,[qa.first]:{...s.sessions[qa.first],hasMoreHistory:true,historyCursor:"1"}}}))');
  await wait('qaHistory.calls>=12 && !qa.store.getState().sessions[qa.first].loadingMoreHistory');
  await delay(250);assert.equal(await js('qaHistory.calls'),12,'failed IPC does not create a retry loop');
  assert.equal(expectedErrors.length,3);await noButton();
  await js('qaHistory.fail=false;qa.scroll().dispatchEvent(new WheelEvent("wheel",{deltaY:-100,bubbles:true}))');
  await wait('!qa.store.getState().sessions[qa.first].hasMoreHistory');
  assert.equal(await js('qaHistory.calls'),13,'a fresh gesture recovers after failed IPC');
  const output=process.env.QA_CAPTURE;
  if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'history-pagination.png'),(await win.webContents.capturePage()).toPNG());}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,calls:await js('qaHistory.calls')}));app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({root, configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dataDir,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false}});
  await server.listen();
  const url = new URL(path.relative(root,tmp)+'/index.html',server.resolvedUrls.local[0]).href;
  await new Promise((resolve,reject)=>{
    const env={...process.env,QA_DATA_DIR:dataDir,QA_URL:url,QA_CAPTURE:process.env.QA_CAPTURE || '',BUBBLE_HOME:path.join(dataDir,'agent-home'),BUBBLE_DESKTOP_PROFILE:'qa',BUBBLE_DESKTOP_USER_DATA:path.join(dataDir,'profile')};
    delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(tmp,'main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let out='';let err='';
    child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Timed out\n'+out+'\n'+err));},120000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code===0){console.log(out.trim());resolve();}else reject(new Error(out+'\n'+err));});
  });
  console.log('history pagination Electron regression passed');
} finally {
  await server?.close();
  await rm(tmp,{recursive:true,force:true});
  await rm(dataDir,{recursive:true,force:true});
}

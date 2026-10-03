import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/queue-'));
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {useAppStore} from '/src/ui/store/useAppStore';
import {useComposerQueueStore} from '/src/ui/store/useComposerQueueStore';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {startQueueAutoFlush} from '/src/ui/lib/queue-auto-flush';
import '/src/ui/index.css';
window.electron={getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],listCodexSkills:async()=>({skills:[]}),sendClientEvent:event=>{if(event.type==="session.continue")qa.sent.push(event)}};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:'qa-model',options:['qa-model'],availableModels:[{name:'qa-model',label:'QA Model'}]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/composer-qa');
store.setState(s=>({connected:true,projectCwd:'/tmp/composer-qa',activeSessionId:id,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:new URLSearchParams(location.search).get('provider')||'codex',model:'qa-model',status:'running',messages:[],hydrated:true}}}));

window.qa={id,store,queue:useComposerQueueStore,sent:[],status:status=>store.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],status}}})),enqueue:text=>useComposerQueueStore.getState().enqueue(id,{id:crypto.randomUUID(),displayPrompt:text,effectivePrompt:text,attachments:[],references:{}})};
qa.preferences=useAppPreferences;
window.electron.readProjectFilePreview=async()=>{qa.previewPending=true;await new Promise(resolve=>qa.releasePreview=resolve);return {kind:'text',ext:'.ts',text:'fixture'};};
useAppPreferences.setState({followUpBehavior:'queue'});
startQueueAutoFlush();
function Harness(){const [visible,setVisible]=useState(true),[split,setSplit]=useState(false);qa.show=setVisible;qa.split=setSplit;return <Tooltip.Provider><div style={{padding:40}}>{visible&&<PromptInput sessionId={id}/>}{visible&&split&&<PromptInput sessionId={id}/>}</div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,show:true}),js=async s=>{try{return await win.webContents.executeJavaScript(s,true)}catch(error){console.error('Renderer expression:',s);throw error}};
 win.webContents.on('console-message',e=>{if(e.level==='error')console.error(e.message)});
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(30)}throw Error('Timed out: '+label)};
 const paste=async text=>{await js('(()=>{const e=document.querySelector("[role=textbox]");e.focus();const d=new DataTransfer();d.setData("text/plain",'+JSON.stringify(text)+');e.dispatchEvent(new ClipboardEvent("paste",{clipboardData:d,bubbles:true,cancelable:true}))})()');await delay(100);};
 try{
  await win.loadURL(process.env.QA_URL);await until('!!document.querySelector("[role=textbox]")','composer');
  await paste('ordinary queue');await until('!document.querySelector("button[aria-label=Send]").disabled','Send ready');
  await js('document.querySelector("button[aria-label=Send]").click()');
  await until('qa.queue.getState().queues[qa.id]?.length===1','queued');
  assert.equal(await js('qa.sent.length'),0,'queue does not interrupt a live turn');
  await js('qa.status("completed")');await until('qa.sent.length===1','ordinary flush');
  assert.equal(await js('qa.sent[0].payload.prompt'),'ordinary queue');
  await js('qa.status("running")');await delay(100);
  await paste('late @src/example.ts');
  await js('document.querySelector("button[aria-label=Send]").click()');await until('qa.previewPending','file normalization pending');
  await js('qa.status("completed")');await delay(100);
  await js('qa.releasePreview()');await delay(200);
  console.log('after completion during send',await js('JSON.stringify({sent:qa.sent.map(e=>e.payload.prompt),queued:qa.queue.getState().queues[qa.id]})'));
  assert.equal(await js('qa.sent.length'),2,'message prepared across turn completion must still dispatch');
  assert.equal(await js('qa.queue.getState().queues[qa.id]?.length??0'),0,'no stranded queue');
  // Direct Steer and the queued card's Steer both dispatch exactly once.
  await js('qa.status("running");qa.preferences.setState({followUpBehavior:"steer"})');await delay(100);
  await paste('direct steer');await js('document.querySelector("button[aria-label=Send]").click()');
  await until('qa.sent.length===3','direct steer');
  assert.equal(await js('qa.sent[2].payload.prompt'),'direct steer');
  await js('qa.preferences.setState({followUpBehavior:"queue"})');await delay(100);
  await paste('chip steer');await js('document.querySelector("button[aria-label=Send]").click()');
  await until('qa.queue.getState().queues[qa.id]?.length===1','chip queued');
  await js('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Steer");b.click();b.click()})()');
  await until('qa.sent.length===4','chip steer');
  assert.equal(await js('qa.sent[3].payload.prompt'),'chip steer');
  assert.equal(await js('qa.queue.getState().queues[qa.id].length'),0);

  // A pane disappearing in the same React batch as completion used to lose
  // its ownership handoff before either flusher saw the transition.
  await js('qa.enqueue("owner handoff");qa.status("completed");qa.show(false)');
  await until('qa.sent.length===5','unmounted completion flush');
  assert.equal(await js('qa.sent[4].payload.prompt'),'owner handoff');
  await js('qa.status("running")');await delay(50);
  await js('qa.status("completed")');await delay(50);
  await js('qa.enqueue("background late enqueue")');
  await until('qa.sent.length===6','late background flush');
  assert.equal(await js('qa.sent[5].payload.prompt'),'background late enqueue');

  // Error/stop never auto-run a queue; its explicit Send action still works.
  await js('qa.status("error");qa.enqueue("retry after error");qa.show(true)');await delay(200);
  assert.equal(await js('qa.sent.length'),6);
  await js('[...document.querySelectorAll("button")].find(b=>b.title==="Send as the next message").click()');
  await until('qa.sent.length===7','manual retry after error');
  await js('qa.status("idle");qa.enqueue("held after stop")');await delay(100);
  assert.equal(await js('qa.sent.length'),7);
  await js('qa.queue.getState().takeAll(qa.id);qa.status("running");qa.split(true)');await delay(150);

  // Split panes and background release share one in-flight reservation.
  await js('qa.exclusive=0;qa.enqueue("batch one");qa.queue.getState().enqueue(qa.id,{id:"exclusive",displayPrompt:"exclusive",effectivePrompt:"exclusive",attachments:[],references:{},exclusive:true,dispatch:()=>qa.exclusive++});qa.enqueue("batch three");qa.status("completed")');
  await until('qa.sent.length===8','first split-pane batch');await delay(100);
  assert.equal(await js('qa.exclusive'),0,'exclusive waits for next completion');
  assert.equal(await js('qa.queue.getState().queues[qa.id].length'),2);
  await js('qa.show(false)');await delay(100);
  assert.equal(await js('qa.exclusive'),0,'unmount cannot dispatch a second batch before acknowledgement');
  await js('qa.status("running")');await delay(50);await js('qa.status("completed")');
  await until('qa.exclusive===1','exclusive next turn');
  await js('qa.status("running")');await delay(50);await js('qa.status("completed")');
  await until('qa.sent.length===9','last ordered batch');
  assert.equal(await js('qa.sent[8].payload.prompt'),'batch three');
  for(const provider of ['bubble','claude']){
   const url=new URL(process.env.QA_URL);url.searchParams.set('provider',provider);
   await win.loadURL(url.href);await until('!!document.querySelector("[role=textbox]")','provider composer');
   await paste(provider+' follow-up');await until('!document.querySelector("button[aria-label=Send]").disabled','provider ready');
   await js('document.querySelector("button[aria-label=Send]").click()');
   await until('qa.queue.getState().queues[qa.id]?.length===1','provider queued');
   assert.equal(await js('qa.sent.length'),0);
   await js('qa.status("completed")');await until('qa.sent.length===1','provider flushed');
   assert.equal(await js('qa.sent[0].payload.provider'),provider);
   assert.equal(await js('qa.sent[0].payload.prompt'),provider+' follow-up');
   await js('qa.status("running");qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],status:"completed",messages:[{type:"user_prompt",prompt:"parent task"},{type:"assistant",uuid:"pending-task",message:{content:[{type:"tool_use",id:"child-task",name:"Task",input:{subagent_type:"explore",description:"background child"}}]}}]}}}))');
   await delay(100);await paste('follow-up after child');
   assert.equal(await js('!!document.querySelector("button[aria-label=Send]")&&!document.querySelector("button[aria-label=Send]").disabled'),true,'background child must allow queuing');
   await js('document.querySelector("button[aria-label=Send]").click()');
   await until('qa.queue.getState().queues[qa.id]?.length===1','waiting for background child');
   assert.equal(await js('qa.sent.length'),1,'must wait for the child result');
   await js('qa.store.setState(s=>({sessions:{...s.sessions,[qa.id]:{...s.sessions[qa.id],messages:[...s.sessions[qa.id].messages,{type:"user",message:{content:[{type:"tool_result",tool_use_id:"child-task",content:"done"}]}}]}}}))');
   await until('qa.sent.length===2','child completion flush without another status change');
   await js('qa.status("running");qa.previewPending=false');await delay(100);
   await paste('preserve @src/example.ts');await js('document.querySelector("button[aria-label=Send]").click()');
   await until('qa.previewPending','error race preparation');
   await js('qa.status("error")');await delay(50);await js('qa.releasePreview()');
   await until('qa.queue.getState().queues[qa.id]?.length===1','failed turn keeps prepared follow-up');
   assert.equal(await js('qa.sent.length'),2,'failure during preparation must not start an automatic retry');
   if(provider==='bubble'){
    await js('qa.queue.getState().takeAll(qa.id);qa.status("running");qa.preferences.setState({followUpBehavior:"steer"})');await delay(100);
    await paste('Bubble direct steer');await js('document.querySelector("button[aria-label=Send]").click()');
    await until('qa.sent.length===3','Bubble direct steer IPC');
    assert.equal(await js('qa.sent[2].payload.prompt'),'Bubble direct steer');
    await js('qa.enqueue("Bubble queued steer")');await delay(100);
    await js('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Steer");b.click();b.click()})()');
    await until('qa.sent.length===4','Bubble card steer IPC');
    assert.equal(await js('qa.sent[3].payload.prompt'),'Bubble queued steer');
    await js('qa.queue.getState().enqueue(qa.id,{id:"image-queue",displayPrompt:"image follow-up",effectivePrompt:"image follow-up",attachments:[{id:"img",name:"fixture.png",path:"/tmp/fixture.png",kind:"image"}],references:{}})');await delay(100);
    assert.equal(await js('document.querySelector("button[title^=Waits]").disabled'),true,'Bubble attachments wait for a full multimodal turn');
    assert.equal(await js('qa.sent.length'),4);
   }
  }
  console.log('QUEUE_QA_OK');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<html><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(tmp, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.aegis-design-qa/**', '**/scripts/**', '**/dist-electron/**'] } } });
  await server.listen();
  const env = { ...process.env, BUBBLE_HOME: path.join(tmp, 'bubble-home'), QA_URL: new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: path.join(root, 'output/playwright/composer-queue') };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data));
    const timeout = setTimeout(() => { child.kill(); reject(Error('Composer queue test timed out')); }, 30000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timeout); try { assert.equal(code, 0); assert(output.includes('QUEUE_QA_OK')); resolve(); } catch(error) { reject(error); } });
  });
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}

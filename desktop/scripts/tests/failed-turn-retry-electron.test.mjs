// Issue #74: exercise the real renderer/store with simulated Bubble IPC events.
// No model requests, production profiles, or real session history are used.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, '.qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.qa/failed-turn-'));
const capture = path.join(root, 'artifacts/issue-74');
let server;
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {ChatPane} from '/src/ui/components/ChatPane';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.electron = {
 sendClientEvent:()=>{},cancelProjectTreeRead:async()=>{},getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),
 getProjectFolders:async()=>[],getModels:async()=>[],
};
const config={defaultModel:'qa-model',options:['qa-model'],availableModels:[{name:'qa-model',label:'QA Model'}]};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>config;
const store=useAppStore;
const id=store.getState().createDraftSession('/tmp/issue-74-fixture');
const base=store.getState().sessions[id];
const event=(type,payload)=>store.getState().handleServerEvent({type,payload:{sessionId:id,...payload}});
const emit=message=>event('stream.message',{message});
const status=value=>event('session.status',{status:value});
const text='FIRST_PARTIAL_74: 已读到项目说明，正在继续检查。';
const thought='FIRST_REASONING_74: 先检查入口和项目配置。';
const error='SIMULATED_FAILURE_74: connection interrupted';
const prompt=()=>emit({type:'user_prompt',prompt:'这个项目看看在做什么',createdAt:Date.now()});
const delta=(type,value)=>emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:type==='thinking_delta'?{type,thinking:value}:{type,text:value}}});
const assistant=(content,phase)=>emit({type:'assistant',uuid:'first-assistant',createdAt:Date.now(),...(phase?{phase}:{}),message:{content}});
window.qa={
 reset:()=>{store.setState(s=>({sessions:{...s.sessions,[id]:{...base,isDraft:false,hydrated:true,provider:'bubble',status:'running',model:'qa-model',messages:[]}}}));prompt();},
 partial:kind=>{if(kind!=='empty')delta(kind==='reasoning'?'thinking_delta':'text_delta',kind==='reasoning'?thought:text);},
 fail:kind=>{
  // Normal Bubble finishTurn flushes its accumulator before the error result.
  // 'unflushed' deliberately omits that event to probe abnormal transport loss.
  if(kind==='text')assistant([{type:'text',text}]);
  if(kind==='reasoning')assistant([{type:'thinking',thinking:thought}]);
  if(kind==='commentary')assistant([{type:'text',text}],'commentary');
  if(kind==='tool'){
   assistant([{type:'text',text}],'commentary');
   emit({type:'assistant',uuid:'tool',message:{content:[{type:'tool_use',id:'read-74',name:'read',input:{path:'README.md'}}]}});
   emit({type:'user',uuid:'tool-result',message:{content:[{type:'tool_result',tool_use_id:'read-74',content:'QA README content'}]}});
  }
  if(kind!=='unflushed')emit({type:'result',subtype:'error',duration_ms:1500,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
  const failure={type:'turn_failure',uuid:'failure-'+store.getState().sessions[id].messages.filter(m=>m.type==='user_prompt').length,createdAt:Date.now(),error};
  emit(failure);emit(failure); // Duplicate delivery must upsert, not duplicate the notice.
  status('error');event('runner.error',{message:error});
 },
 retry:()=>{status('running');prompt();},
 hydrate:messages=>{store.setState(s=>({sessions:{...s.sessions,[id]:{...base,provider:'bubble',isDraft:false,messages:[],lastTurnError:undefined}}}));event('session.history',{status:'completed',messages});},
 complete:()=>{emit({type:'assistant',uuid:'second-assistant',message:{content:[{type:'text',text:'SECOND_REPLY_74: 第二轮完成。'}]}});emit({type:'result',subtype:'success',duration_ms:1000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});status('completed');},
 snapshot:()=>{const s=store.getState().sessions[id];return {status:s.status,messages:s.messages,userCount:s.messages.filter(m=>m.type==='user_prompt').length,streaming:s.streaming,lastTurnError:s.lastTurnError,visibleText:document.querySelector('#chat').innerText,failureVisible:!!document.querySelector('[data-turn-failure]'),workBeforeFailure:(()=>{const failure=document.querySelector('[data-turn-failure]');const failureIndex=s.messages.findIndex(m=>m.type==='turn_failure');const work=[...document.querySelectorAll('[data-message-index]')].filter(el=>{const index=Number(el.dataset.messageIndex);return index<failureIndex&&s.messages[index]?.type==='assistant';});return !!failure&&work.length>0&&work.every(el=>!!(el.compareDocumentPosition(failure)&Node.DOCUMENT_POSITION_FOLLOWING));})(),disclosures:[...document.querySelectorAll('.workstream-toggle-row button')].map(b=>({text:b.textContent,expanded:b.getAttribute('aria-expanded')}))};},
 expand:()=>{for(const b of document.querySelectorAll('#chat button[aria-expanded="false"]'))b.click();},
};
window.qa.reset();store.getState().setTheme('light');
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div id="chat" style={{height:'100vh',display:'flex'}}><ChatPane paneId="qa" sessionId={id} isActive onActivate={()=>{}} /></div></Tooltip.Provider>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.setPath('sessionData',path.join(__dirname,'session-data'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:900,show:false});
 const errors=[],results=[];
 w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=s=>w.webContents.executeJavaScript(s,true);
 const snap=async(kind,stage)=>{
  await delay(250);
  const state=await js('qa.snapshot()');
  fs.writeFileSync(path.join(process.env.QA_CAPTURE,kind+'-'+stage+'.png'),(await w.webContents.capturePage()).toPNG());
  return state;
 };
 try{
  await w.loadURL(process.env.QA_URL);
  for(let i=0;i<100&&!await js('!!window.qa && !!document.querySelector("#chat")');i++)await delay(100);
  for(const kind of ['text','reasoning','commentary','tool','empty','unflushed']){
   await js('qa.reset()');await delay(100);
   await js('qa.partial('+JSON.stringify(kind)+')');
   const partial=await snap(kind,'partial');
   await js('qa.fail('+JSON.stringify(kind)+')');
   const failed=await snap(kind,'failed');
   assert(failed.failureVisible,kind+': first error is visible');
   await js('qa.retry()');
   const retry=await snap(kind,'retry');
   assert.equal(retry.userCount,2,kind+': both prompts retained');
   assert.deepEqual(retry.messages.slice(0,-1),failed.messages,kind+': retry preserves all committed history');
   assert.equal(retry.failureVisible,true,kind+': old failure notice remains visible');
   assert.equal(await js('document.querySelectorAll("[data-turn-failure]").length'),1,'one notice despite result, duplicate message and runner.error');
   assert(retry.visibleText.indexOf('SIMULATED_FAILURE_74')<retry.visibleText.lastIndexOf('这个项目看看在做什么'),'failure stays before the second prompt');
   if(kind==='text')assert(retry.visibleText.includes('FIRST_PARTIAL_74'), 'normal flushed partial remains visible');
   if(kind==='unflushed'){
    assert(partial.visibleText.includes('FIRST_PARTIAL_74'),'unflushed text was visible while streaming');
    assert(!retry.visibleText.includes('FIRST_PARTIAL_74'),'unflushed text is gone after failure/retry');
   }
   // Inspect collapsed history accessibility, not merely DOM text existence.
   for(let i=0;i<3;i++){await js('qa.expand()');await delay(100);}
   const expanded=await snap(kind,'expanded');
   if(!['empty','unflushed'].includes(kind)){
    // Reasoning is now summarized as an activity, not exposed verbatim.
    if(kind!=='reasoning')assert(expanded.visibleText.includes('FIRST_PARTIAL_74'),kind+': old content remains accessible');
    for(const [stage,state] of [['failed',failed],['retry',retry],['expanded',expanded]]){
     assert(state.workBeforeFailure,kind+': work/answer must precede failure at '+stage);
    }
   }
   await js('qa.complete()');
   const completed=await snap(kind,'completed');
   if(kind==='text')assert(completed.visibleText.includes('FIRST_PARTIAL_74'),'partial survives second completion');
   assert(completed.failureVisible,'first failure remains after second completion');
   await js('qa.hydrate('+JSON.stringify(completed.messages)+')');
   const reopened=await snap(kind,'reopened');
   assert(reopened.failureVisible,'failure survives fresh session history hydration without lastTurnError');
   if(!['empty','unflushed'].includes(kind))assert(reopened.workBeforeFailure,kind+': history hydration preserves work-before-failure order');
   results.push({kind,partial,failed,retry,expanded,completed,reopened});
  }
  await js('qa.reset();qa.fail("empty");qa.retry();qa.fail("empty")');await delay(250);
  assert.equal(await js('document.querySelectorAll("[data-turn-failure]").length'),2,'identical failures on two turns stay separate');
  await js('qa.retry()');await delay(250);
  assert.equal(await js('document.querySelectorAll("[data-turn-failure]").length'),2,'third turn preserves both historical failures');
  assert.deepEqual(errors,[],'renderer errors');
  console.log(JSON.stringify(results.map(r=>({kind:r.kind,failedText:r.failed.visibleText,retryText:r.retry.visibleText,disclosures:r.retry.disclosures})),null,2));
  fs.writeFileSync(path.join(process.env.QA_CAPTURE,'results.json'),JSON.stringify({results,errors},null,2));
  console.log('Issue #74 renderer simulation passed: six failure/retry scenarios.');app.exit(0);
 }catch(error){
  console.error(error,errors);
  fs.writeFileSync(path.join(process.env.QA_CAPTURE,'results.json'),JSON.stringify({results,errors,failure:String(error)},null,2));
  fs.writeFileSync(path.join(process.env.QA_CAPTURE,'failure.png'),(await w.webContents.capturePage()).toPNG());app.exit(1);
 }
});
`;
try {
 await mkdir(capture, { recursive: true });
 await writeFile(path.join(dir, 'index.html'), '<html><body style="margin:0"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir, 'probe.tsx'), harness);
 await writeFile(path.join(dir, 'main.cjs'), main);
 server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
 await server.listen();
 const env = { ...process.env, BUBBLE_HOME: path.join(dir, 'bubble-home'), QA_URL: new URL(path.relative(root, dir) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: capture };
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve, reject) => {
  const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); reject(Error('Electron simulation timed out')); }, 90000);
  child.on('error', error => { clearTimeout(timeout); reject(error); });
  child.on('exit', code => { clearTimeout(timeout); try { assert.equal(code, 0, 'Electron simulation exit code'); resolve(); } catch (error) { reject(error); } });
 });
} finally {
 await server?.close();
 await rm(dir, { recursive: true, force: true });
}

import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/memory-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bubble-memory-qa-'));
let server;
const harness = String.raw`import { installReactPerformanceCleanup } from '/src/ui/utils/react-performance-cleanup';
const disposePerformanceCleanup=installReactPerformanceCleanup();

import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ActivitySummary,WorkstreamActivityLabel} from '/src/ui/components/WorkstreamPrimitives';
import {WorkstreamDisclosure} from '/src/ui/components/ToolExecutionBatch';
import {ChatPane} from '/src/ui/components/ChatPane';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';

window.electron = {
 sendClientEvent:()=>{},cancelProjectTreeRead:async()=>{},getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),
 getProjectFolders:async()=>[],getModels:async()=>[],
 readProjectFilePreview:async()=>{const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');x.fillStyle='#c5d2bf';x.fillRect(0,0,320,240);return {kind:'image',dataUrl:c.toDataURL()}},
};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
const config={defaultModel:'gpt-test',options:['gpt-test'],availableModels:[{name:'gpt-test',label:'GPT Test'}]};
window.electron.getCodexModelConfig=async()=>config;
const store=useAppStore;
const chatId=store.getState().createDraftSession('/tmp/workstream-ui');
const prompt={type:'user_prompt',prompt:'Inspect the project and summarize the result',createdAt:1000};
const thought={type:'assistant',uuid:'thought',createdAt:1100,message:{content:[{type:'thinking',thinking:'Check the project configuration'}]}};
const read={type:'assistant',uuid:'read',createdAt:1200,message:{content:[{type:'tool_use',id:'read-tool',name:'Read',input:{file_path:'/tmp/project/package.json'}}]}};
const result={type:'user',uuid:'read-result',createdAt:1500,message:{content:[{type:'tool_result',tool_use_id:'read-tool',content:'{"name":"demo"}'}]}};
store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],isDraft:false,hydrated:true,provider:'codex',status:'running',model:'gpt-test',messages:[prompt,thought,read,result]}}}));
const emit=message=>store.getState().handleServerEvent({type:'stream.message',payload:{sessionId:chatId,message}});


const live=store.getState().sessions[chatId];
store.setState({sessions:{[chatId]:{...live,provider:'bubble',messages:[{type:'user_prompt',prompt:'Create a detailed voxel scene',createdAt:Date.now()}],status:'running'}}});
createRoot(document.getElementById('root')).render(<Tooltip.Provider><ChatPane paneId="qa" sessionId={chatId} isActive onActivate={()=>{}} codexModelConfig={config}/></Tooltip.Provider>);
let count=0;
const delta='Consider the scene geometry, materials, lighting and camera. Verify the building proportions and visibility. ';
window.qa={store,chatId,disposePerformanceCleanup,start(){window.probeTimer=setInterval(()=>{emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:delta}}});if(++count>=3000)clearInterval(window.probeTimer)},4)},stats(){return {count,chars:store.getState().sessions[chatId].streaming?.thinking.length,nodes:document.querySelectorAll('*').length}}};
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));app.setPath('sessionData',path.join(process.env.QA_DATA_DIR,'session-data'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.commandLine.appendSwitch('enable-precise-memory-info');
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{backgroundThrottling:false}});
 w.webContents.on('render-process-gone',(_,d)=>{console.error('PROBE CRASH',d);app.exit(2)});
 w.webContents.on('console-message',e=>{if(e.level==='error')console.error('RENDERER',e.message.slice(0,700))});
 try{
 await w.loadURL(process.env.QA_URL);
 for(let i=0;i<200;i++){if(await w.webContents.executeJavaScript('!!window.qa'))break;await delay(100)}
 w.webContents.debugger.attach('1.3');
 await w.webContents.executeJavaScript("performance.mark('application-mark');performance.measure('application-measure',{start:0,end:1,detail:{keep:true}});qa.start()");
 for(let i=0;i<5;i++){
 await delay(5000);await w.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
 console.log(JSON.stringify({t:i*5+5,...await w.webContents.executeJavaScript('qa.stats()'),heap:await w.webContents.debugger.sendCommand('Runtime.getHeapUsage'),dom:await w.webContents.debugger.sendCommand('Memory.getDOMCounters'),memory:app.getAppMetrics().find(m=>m.pid===w.webContents.getOSProcessId())?.memory}));
 }
 const final=await w.webContents.executeJavaScript("(()=>{const measures=performance.getEntriesByType('measure');return {...qa.stats(),react:measures.filter(e=>e.detail?.devtools?.track==='Components ⚛').length,appMeasure:measures.filter(e=>e.name==='application-measure').length,appMark:performance.getEntriesByName('application-mark','mark').length}})()");
 assert.equal(final.count,3000);assert.equal(final.chars,327000,'full reasoning is preserved');
 assert(final.react<100,'React performance records do not grow with streaming updates');
 assert.equal(final.appMeasure,1);assert.equal(final.appMark,1);
 const memory=app.getAppMetrics().find(m=>m.pid===w.webContents.getOSProcessId()).memory;
 assert(memory.workingSetSize<1024*1024,'native memory stays below 1 GiB for the regression workload');
 await w.webContents.executeJavaScript("qa.disposePerformanceCleanup();performance.measure('disposed-probe',{start:0,end:1,detail:{devtools:{track:'Components ⚛'}}})");await delay(100);
 assert.equal(await w.webContents.executeJavaScript("performance.getEntriesByName('disposed-probe','measure').length"),1,'HMR disposal disconnects the observer');
 console.log('PASS real ChatPane streaming: bounded native timeline, full reasoning retained, application timing preserved, observer disposal');
 app.exit(0);
 }catch(e){console.error(e);app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);
 await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dataDir,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false}});
 await server.listen();
 const env={...process.env,QA_DATA_DIR:dataDir,BUBBLE_HOME:path.join(dataDir,'agent-home'),BUBBLE_DESKTOP_PROFILE:'qa',BUBBLE_DESKTOP_USER_DATA:path.join(dataDir,'profile'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'artifacts/memory-probe')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Electron test timed out'))},120000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron test failed: '+code))});
 });
} finally { await server?.close();await rm(dir,{recursive:true,force:true});await rm(dataDir,{recursive:true,force:true}); }

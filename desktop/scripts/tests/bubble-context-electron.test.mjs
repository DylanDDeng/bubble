import { createServer } from 'vite';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root = process.cwd();
await mkdir('.aegis-design-qa', { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/context-'));
const data = await mkdtemp(path.join(os.tmpdir(), 'bubble-context-ui-'));
const electron = path.join(root, 'node_modules/.bin/electron');
const env = { ...process.env, BUBBLE_HOME: path.join(data, 'agent'), QA_DATA: data, BUBBLE_CONTEXT_FIXTURE: path.join(data, 'history.json'), BUBBLE_LEGACY_CONTEXT_FIXTURE: path.join(data, 'legacy-history.json') };
delete env.ELECTRON_RUN_AS_NODE;
function run(file, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [file], { env: { ...env, ...extra }, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Context UI timed out')); }, 60000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Electron exited ' + code)); });
  });
}
let server;
try {
  await run(path.join(root, 'scripts/tests/bubble-context-adapter.cjs'));
  await run(path.join(root, 'scripts/tests/bubble-history-context.cjs'));
  const legacy = JSON.parse(await readFile(env.BUBBLE_LEGACY_CONTEXT_FIXTURE, 'utf8'));
  const history = JSON.parse(await readFile(env.BUBBLE_CONTEXT_FIXTURE, 'utf8'));
  await writeFile(path.join(dir, 'index.html'), '<div id="root"></div><script type="module" src="./probe.tsx"></script>');
  await writeFile(path.join(dir, 'probe.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {ChatPane} from '/src/ui/components/ChatPane';
import {useAppStore as store} from '/src/ui/store/useAppStore';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import {getLatestBubbleContextSnapshot} from '/src/ui/utils/context-usage';
import '/src/ui/index.css';
window.electron={sendClientEvent:()=>{},cancelProjectTreeRead:async()=>{},getProjectTree:async()=>null,getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[]};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:'openai:gpt-6-astra',options:[],availableModels:[]});
const id=store.getState().createDraftSession('/tmp/context-qa'),history=${JSON.stringify(history)};
const prompt={type:'user_prompt',prompt:'Inspect the project',createdAt:Date.now()-10000};
const thought={type:'assistant',uuid:'thought',message:{content:[{type:'thinking',thinking:'Inspecting the repository'}]}};
const set=messages=>store.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,hydrated:true,provider:'bubble',model:'openai:gpt-6-astra',status:'running',messages:[prompt,thought,...messages]}}}));
window.qa={legacy:()=>set(${JSON.stringify(legacy)}),before:()=>set(history.slice(0,history.findIndex(m=>m.subtype==='compact_status'))),started:()=>set(history.slice(0,history.findIndex(m=>m.subtype==='compact_status')+1)),completed:()=>set(history.slice(0,-3)),failed:()=>set(history.slice(0,-1)),reload:()=>set(JSON.parse(JSON.stringify(store.getState().sessions[id].messages.slice(2)))),snapshot:()=>getLatestBubbleContextSnapshot(store.getState().sessions[id].messages,'openai:gpt-6-astra')};
qa.before();useAppPreferences.setState({reduceMotion:'on',showContextUsage:true});store.getState().setTheme('light');
createRoot(document.getElementById('root')).render(<Tooltip.Provider><div style={{height:'100vh',display:'flex'}}><ChatPane paneId="qa" sessionId={id} isActive onActivate={()=>{}}/></div></Tooltip.Provider>);
`);
  await writeFile(path.join(dir, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict'),path=require('node:path');
app.setPath('userData',path.join(process.env.QA_DATA,'profile'));app.setPath('sessionData',path.join(process.env.QA_DATA,'session-data'));
app.whenReady().then(async()=>{const w=new BrowserWindow({width:1100,height:850,show:false,webPreferences:{backgroundThrottling:false}});w.webContents.on('console-message',e=>{if(e.level==='error')console.error('Renderer:',e.message)});const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error('Expression:',s);throw e}};const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{await w.loadURL(process.env.QA_URL);for(let i=0;i<100;i++){if(await js('!!window.qa'))break;await delay(100)}await delay(500);
assert.equal(await js('qa.snapshot().percent'),29);assert(await js('!!document.querySelector("button[aria-label=\\"Bubble context and token usage\\"]")'));
await js('qa.started()');await delay(400);assert((await js('document.body.innerText')).includes('Compacting conversation'));
await js('qa.completed()');await delay(400);assert.equal(await js('qa.snapshot().percent'),11);assert((await js('document.body.innerText')).includes('Conversation auto-compacted'));assert(!(await js('document.body.innerText')).includes('Compacting conversation'));
await js('qa.reload()');await delay(300);assert.equal(await js('qa.snapshot().used'),30000);
await js('qa.failed()');await delay(300);assert(!(await js('document.body.innerText')).includes('Compacting conversation'));
await js('qa.legacy()');await delay(300);assert.equal(await js('qa.snapshot().percent'),29);await js('qa.reload()');await delay(300);assert.equal(await js('qa.snapshot().used'),79228);
console.log('PASS: legacy history recovery and real ChatPane context ring, compacting indicator, completion boundary, reload and failure cleanup');app.exit(0);
}catch(e){console.error(e);app.exit(1)}});
`);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(data, 'vite'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  await run(path.join(dir, 'main.cjs'), { QA_URL: new URL(path.relative(root, dir) + '/index.html', server.resolvedUrls.local[0]).href });
} finally { await server?.close(); await rm(dir, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }

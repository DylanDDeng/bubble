// Real ChatPane/store event replay. All sessions, profiles and Agent data are synthetic.
import { createServer } from 'vite';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/subagent-visibility-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bubble-subagent-visibility-'));
const capture = path.join(root, 'artifacts/subagent-visibility');
let server;

const harness = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {ChatPane} from '/src/ui/components/ChatPane';
import {SubagentPanel} from '/src/ui/components/SubagentPanel';
import {useAppStore as store} from '/src/ui/store/useAppStore';
import {useAppPreferences} from '/src/ui/store/useAppPreferences';
import '/src/ui/index.css';
window.electron={sendClientEvent:()=>{},cancelProjectTreeRead:async()=>{},getProjectTree:async()=>null,
 getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),
 getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],
 getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},
 getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),
 getProjectFolders:async()=>[],getModels:async()=>[]};
const config={defaultModel:'qa-model',options:['qa-model'],availableModels:[{name:'qa-model',label:'QA Model'}]};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>config;
const id=store.getState().createDraftSession('/tmp/subagent-visibility-fixture');
const base=store.getState().sessions[id];
const startedAt=Date.now()-24000;
const event=(type,payload)=>store.getState().handleServerEvent({type,payload:{sessionId:id,...payload}});
const emit=message=>event('stream.message',{message:{createdAt:Date.now(),...message}});
const tool=(id,name,input={})=>emit({type:'assistant',uuid:id,message:{content:[{type:'tool_use',id,name,input}]}});
const result=(id,content='ok',is_error=false)=>emit({type:'user',uuid:id+'-result',message:{content:[{type:'tool_result',tool_use_id:id,content,is_error}]}});
const child=(status='running',activity='Read · session-store.ts',n=0)=>emit({type:'assistant',uuid:'child-state-'+n,parentToolUseId:'spawn-'+n,
 bubbleSubagent:{agentId:'child-'+n,anchorId:'spawn-'+n,nickname:['Niklaus','Ada','Grace','Linus'][n],role:'reviewer',task:'Review error persistence and test coverage',status,activity,startedAt,updatedAt:Date.now(),pendingInputCount:0},message:{content:[]}});
const reset=()=>{
 store.setState(s=>({activeSessionId:id,sessions:{...s.sessions,[id]:{...base,isDraft:false,hydrated:true,provider:'bubble',status:'running',model:'qa-model',messages:[]}}}));
 emit({type:'user_prompt',prompt:'Review the error persistence fix',createdAt:startedAt});
};
window.qa={store,id,tool,result,child,emit,
 creating:()=>{reset();tool('spawn-0','spawn_agent',{agent_type:'reviewer',message:'Review error persistence and test coverage'})},
 failedSpawn:()=>{reset();tool('spawn-failed','spawn_agent',{message:'Review the repository'});result('spawn-failed','No available agent slot',true)},
 start:()=>{reset();tool('spawn-0','spawn_agent',{agent_type:'reviewer',message:'Review error persistence and test coverage'});child();result('spawn-0','Spawned Niklaus');tool('read','Read',{path:'README.md'});result('read');tool('shell','Bash',{command:'git diff --stat'});result('shell');},
 wait:()=>tool('wait-1','wait_agent',{agent_ids:['child-0']}),
 timeout:()=>result('wait-1','Timed out; Niklaus is still running'),
 nextWait:()=>tool('wait-2','wait_agent',{}),
 complete:()=>{child('completed','Writing response');result('wait-2');emit({type:'assistant',uuid:'answer',phase:'final_answer',message:{content:[{type:'text',text:'Review finished. Two findings are ready.'}]}});emit({type:'result',subtype:'success',duration_ms:30000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});event('session.status',{status:'completed'});},
 reloadHistory:()=>{const s=store.getState().sessions[id],messages=JSON.parse(JSON.stringify(s.messages));store.setState(p=>({sessions:{...p.sessions,[id]:{...s,messages:[]}}}));event('session.history',{status:s.status,messages});},
 parallel:()=>{reset();emit({type:'assistant',uuid:'parallel',message:{content:[0,1,2,3].map(n=>({type:'tool_use',id:'spawn-'+n,name:'spawn_agent',input:{agent_type:'reviewer',message:'Review task '+n}}))}});for(let n=0;n<4;n++)child('running','Reading files',n);tool('read','Read',{path:'README.md'});result('read');tool('wait-all','wait_agent',{agent_ids:['child-0','child-1','child-2','child-3']});},
 stop:()=>event('session.status',{status:'interrupted'}),
 dark:()=>store.getState().setTheme('dark')
};
qa.start();store.getState().setTheme('light');useAppPreferences.setState({reduceMotion:'on'});
function App(){const tab=store(s=>s.activeRightUtilityTab);const selected=tab?.startsWith('subagent:')?tab.slice(9):null;return <Tooltip.Provider><div style={{display:'flex',height:'100vh',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
 <main id="chat" style={{display:'flex',flex:1,minWidth:0}}><ChatPane paneId="qa" sessionId={id} isActive onActivate={()=>{}} /></main>
 {selected&&<aside id="child-panel" style={{width:360}}><SubagentPanel collapsed={false} sessionId={id} subagentId={selected}/></aside>}
 </div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<App/>);
`;

const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));
app.setPath('sessionData',path.join(process.env.QA_DATA_DIR,'session-data'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:850,show:false});
 const errors=[];
 w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error('Failed expression:',s);throw e}};
 const until=async(s,label)=>{for(let i=0;i<80;i++){if(await js(s))return;await delay(100)}throw Error('Timed out: '+label+' '+JSON.stringify(errors))};
 const run=async s=>{await js(s);await delay(250)};
 const click=s=>run('document.querySelector('+JSON.stringify(s)+').click()');
 const shot=async name=>fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG());
 const row='#chat [data-subagent-row="spawn-0"]';
 const visible=s=>js('(()=>{const e=document.querySelector('+JSON.stringify(s)+');return !!e&&e.getBoundingClientRect().height>0&&!e.closest("[aria-hidden=true]")})()');
 try{
  await w.loadURL(process.env.QA_URL);
  await until('!!document.querySelector("#chat [data-subagent-row]")','child row');
  assert(await visible(row),'child is visible before expanding ordinary tools');
  const lane='#chat [data-subagent-anchor="spawn-0"]';
  const toggle=lane+' button[aria-expanded]';
  const label=()=>js('document.querySelector('+JSON.stringify(lane+' [data-subagent-state-label]')+').textContent');
  const single=async()=>{
   assert.equal(await js('document.querySelectorAll("#chat [data-subagent-anchor]").length'),1,'one persistent child row');
   assert.equal(await js('document.querySelectorAll("#chat [data-agent-control]").length'),0,'no independent wait rows, including historical waits');
  };
  await run('qa.creating()');
  await js('window.creationRow=document.querySelector('+JSON.stringify(lane)+')');
  assert((await label()).includes('Creating'));
  await click(toggle);
  await run('qa.result("spawn-0","Spawn accepted")');assert((await label()).includes('Created'),'creation acknowledgement without runtime state does not invent completion');
  await run('qa.child("queued")');assert((await label()).includes('Queued'));
  await run('qa.child("running")');assert((await label()).includes('Working'));
  assert(await js('document.querySelector('+JSON.stringify(lane)+')===creationRow'),'creation and lifecycle update the same DOM row');
  assert.equal(await js('document.querySelector('+JSON.stringify(toggle)+').getAttribute("aria-expanded")'),'true','state changes preserve disclosure');
  assert((await js('document.querySelector('+JSON.stringify(lane)+').innerText')).includes('Review error persistence and test coverage'));
  await click(toggle);await single();
  await run('qa.start()');
  assert.equal(await js('document.querySelector('+JSON.stringify(row)+').dataset.subagentStatus'),'pending','spawn success does not complete child');
  assert.equal(await js('document.querySelector("#chat [data-workstream-group]").getAttribute("aria-expanded")'),'false','ordinary tools stay collapsed');
  await run('qa.wait()');
  await single();assert((await label()).includes('Working'));
  await click(toggle);assert.equal(await js('document.querySelectorAll("#chat [data-subagent-operation]").length'),0,'scheduler calls are absent from task details');
  await click(toggle);
  await click('#chat [data-workstream-group]');
  await click('#chat [data-workstream-group]');
  const runningText=await js('document.querySelector('+JSON.stringify(row)+').innerText');
  await js('window.qaRow=document.querySelector('+JSON.stringify(row)+');window.qaMutations=[];window.qaObserver=new MutationObserver(records=>qaMutations.push(...records.map(r=>r.type)));qaObserver.observe(qaRow,{subtree:true,characterData:true,childList:true,attributes:true})');
  // Reproduce the original 0/1/2-second reset: new activity timestamps arrive
  // while seconds pass. Codex's lifecycle row has no mutable clock or activity line.
  for(const activity of ['Analyzing','Grep · ipc-handlers.ts','Writing response','Analyzing results']){
   await run('qa.child("running",'+JSON.stringify(activity)+')');await delay(1100);
   assert.equal(await js('document.querySelector('+JSON.stringify(row)+').innerText'),runningText,'activity events do not rewrite the task chip');
   assert(await js('document.querySelector('+JSON.stringify(row)+')===qaRow'),'activity preserves the same DOM node');
  }
  assert.deepEqual(await js('qaMutations'),[],'no per-second text or attribute mutations in the chip');
  await js('qaObserver.disconnect()');
  assert.equal(await js('document.querySelector("#chat [data-workstream-group]").getAttribute("aria-expanded")'),'false','progress preserves manual collapse');
  assert(!(await js('document.querySelector("#chat").innerText')).includes('since last update'),'no update-age counter in main trace');
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-row]").length'),1,'state updates do not duplicate rows');
  await shot('running-light');
  const waitTarget = await js('(()=>{const e=document.querySelector("#chat [data-subagent-row]");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  assert(await js('!!document.elementFromPoint('+waitTarget.x+','+waitTarget.y+')?.closest("[data-subagent-row]")'),'disclosure overlay does not intercept the child name');
  w.webContents.sendInputEvent({type:'mouseDown',...waitTarget,button:'left',clickCount:1});
  w.webContents.sendInputEvent({type:'mouseUp',...waitTarget,button:'left',clickCount:1});
  await until('!!document.querySelector("#child-panel")','wait opens child panel');
  assert((await js('document.querySelector("#child-panel").innerText')).includes('Niklaus'));
  assert(!(await js('document.querySelector("#child-panel").innerText')).includes('since last update'),'no update-age counter in details');
  assert((await js('document.querySelector("#child-panel").innerText')).includes('Running…'),'panel uses Coworker running indicator');
  assert.equal(await js('document.querySelector("#child-panel [data-subagent-task] p").textContent'),'Review error persistence and test coverage','full dispatch instruction appears first');
  await run('qa.emit({type:"assistant",uuid:"child-narration",parentToolUseId:"spawn-0",message:{content:[{type:"text",text:"Inspecting persistence now."}]}})');
  assert(await js('(()=>{const task=document.querySelector("#child-panel [data-subagent-task]"),reply=[...document.querySelectorAll("#child-panel p")].find(p=>p.textContent==="Inspecting persistence now.");return !!reply&&task.getBoundingClientRect().bottom<=reply.getBoundingClientRect().top})()'),'task instructions precede child activity');
  assert(!(await js('document.querySelector("#child-panel").innerText')).includes('Task and coordination details'),'no mixed details footer');
  await shot('task-before-trace');

  await run('qa.store.setState({activeRightUtilityTab:null})');
  await run('qa.timeout()');await single();
  assert((await label()).includes('Working'),'timeout is not child completion');
  await click(toggle);
  assert(!(await js('document.querySelector("#chat").innerText')).includes('Wait timed out'),'timeout is not ordinary task content');
  await run('qa.nextWait()');await single();
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-operation]").length'),0,'both waits remain hidden from task details');
  await run('qa.result("wait-2","Timed out; still running");qa.tool("wait-3","wait_agent",{})');await single();
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-operation]").length'),0,'repeated timeouts add no visual clutter');
  await run('qa.reloadHistory()');await single();
  if(await js('document.querySelector('+JSON.stringify(toggle)+').getAttribute("aria-expanded")==="false"'))await click(toggle);
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-operation]").length'),0,'history reload does not restore scheduler clutter');
  await js('window.finishingRow=document.querySelector('+JSON.stringify(lane)+')');
  await run('qa.child("completed","Writing response")');
  assert((await label()).includes('Finished'));
  assert(await js('document.querySelector('+JSON.stringify(lane)+')===finishingRow'),'completion updates the same row');
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-operation]").length'),0,'finishing keeps the single lifecycle status');
  await run('qa.result("wait-3","status: completed")');await single();
  await run('qa.complete()');
  assert.equal(await js('document.querySelector("#chat .workstream-toggle-row button").getAttribute("aria-expanded")'),'false','whole completed turn may collapse');
  await click('#chat .workstream-toggle-row button');
  assert(await visible(row),'completed child accessible after one turn disclosure');
  assert.equal(await js('document.querySelector('+JSON.stringify(row)+').dataset.subagentStatus'),'success');
  const completedTitle=await js('document.querySelector('+JSON.stringify(row)+').title');
  assert(/\d+s/.test(completedTitle),'completed total duration remains in hover details');
  await delay(1100);
  assert.equal(await js('document.querySelector('+JSON.stringify(row)+').title'),completedTitle,'completed duration does not tick');
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-wait]").length'),0);
  if(await js('document.querySelector('+JSON.stringify(toggle)+').getAttribute("aria-expanded")==="true"'))await click(toggle);
  await shot('single-row-finished');
  await run('qa.reloadHistory()');
  const turnToggle='#chat .workstream-toggle-row button';
  if(await js('document.querySelector('+JSON.stringify(turnToggle)+').getAttribute("aria-expanded")==="false"'))await click(turnToggle);
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-row]").length'),1,'completed history keeps one stable child');
  assert.equal(await js('document.querySelector('+JSON.stringify(row)+').title'),completedTitle,'history restores the same duration');
  await single();
  await click(row);
  assert(!(await js('document.querySelector("#child-panel").innerText')).includes('Wait returned'),'completed child panel hides wait results');
  await run('qa.creating();qa.tool("spawn-0","spawn_agent",{message:"Long dispatch instruction. ".repeat(30)})');
  // Use a distinct anchor so a new dispatch is selected without stale disclosure state.
  await run('qa.tool("long-spawn","spawn_agent",{message:"Long dispatch instruction. ".repeat(30)});qa.store.getState().openSubagentPanel("long-spawn")');
  assert.equal(await js('document.querySelector("#child-panel [data-subagent-task] details").open'),false,'long instructions start collapsed before runtime arrives');
  await click('#child-panel [data-subagent-task] summary');
  assert.equal(await js('document.querySelector("#child-panel [data-subagent-task] p").textContent'), 'Long dispatch instruction. '.repeat(30),'expansion keeps the complete instruction');
  await run('qa.store.setState({activeRightUtilityTab:null})');
  await run('qa.failedSpawn()');
  assert((await js('document.querySelector("#chat [data-subagent-state-label]").textContent')).includes('Failed to create'));
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-anchor]").length'),1,'failed creation stays in its original row');
  await click('#chat [data-subagent-anchor] button[aria-expanded]');
  assert((await js('document.querySelector("#chat").innerText')).includes('No available agent slot'));
  await run('qa.parallel()');
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-row]").length'),4,'one visible row for each child');
  assert.equal(await js('document.querySelectorAll("#chat [data-agent-control]").length'),0);
  await click('#chat [data-subagent-row=spawn-3]');
  await until('document.querySelector("#child-panel")?.innerText.includes("Linus")','fourth child name opens its panel');
  await run('qa.store.setState({activeRightUtilityTab:null})');
  await run('qa.child("completed","Done",1);qa.result("wait-all","agent_id: child-1; status: completed")');
  assert.equal(await js('document.querySelector("#chat [data-subagent-row=spawn-0]").dataset.subagentStatus'),'pending','another child completing does not finish this child');
  await click(toggle);
  assert(!(await js('document.querySelector("#chat").innerText')).includes('Wait returned'),'multi-target return stays in raw records');
  await click(toggle);
  await run('qa.child("failed","Review failed",1)');
  assert.equal(await js('document.querySelector("#chat [data-subagent-row=spawn-1]").dataset.subagentStatus'),'error','failure affects only its child');
  await run('qa.tool("mixed","wait_agent",{agent_ids:["child-0","missing"]});qa.result("mixed","Unknown subagent: missing",true)');
  assert.equal(await js('document.querySelectorAll("#chat [data-agent-control=mixed]").length'),1,'mixed known/unknown target failure is not hidden');
  await run('qa.store.getState().setThemeVariantCodeThemeId("light","arc")');await shot('parallel-arc');
  assert.equal(await js('document.documentElement.dataset.codeThemeId'),'arc');
  await run('qa.dark()');await shot('parallel-dark');
  w.setContentSize(390,850);await delay(250);await shot('narrow');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'no horizontal overflow');
  await run('qa.stop()');
  assert.equal(await js('document.querySelectorAll("#chat [data-subagent-wait]").length'),0,'stopping removes live wait');
  assert.equal(await js('document.querySelector("#chat [data-subagent-row=spawn-0]").dataset.subagentStatus'),'interrupted');
  assert.deepEqual(errors,[],'no renderer errors');
  console.log('PASS: single child row identity, creation/queue/run/finish, hidden coordination calls, task-first panel, history, multi-target results, failures and narrow layout');
  app.exit(0);
 }catch(e){console.error(e);console.error(errors);await shot('failure');app.exit(1)}
});
`;

try {
  await mkdir(capture, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<html><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
  await writeFile(path.join(dir, 'fixture.tsx'), harness);
  await writeFile(path.join(dir, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(dataDir, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const env = { ...process.env, QA_DATA_DIR: dataDir, BUBBLE_HOME: path.join(dataDir, 'agent-home'), BUBBLE_DESKTOP_PROFILE: 'qa', BUBBLE_DESKTOP_USER_DATA: path.join(dataDir, 'profile'),
    QA_URL: new URL(path.relative(root, dir) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: capture };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(Error('Subagent UI test timed out')); }, 60000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error('Subagent UI test failed: ' + code)); });
  });
} finally {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}

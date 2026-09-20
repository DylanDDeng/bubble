import { createServer } from 'vite';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/workstream-'));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bubble-trace-qa-'));
let server;
const harness = `
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

useAppStore.getState().setTheme('light');
const tool = (id, status='success') => ({id,type:'tool',toolName:'mcp__docs__read',kind:'mcp_tool_call',summary:'Read project documentation '+id,status,
  block:{type:'tool_use',id,name:'mcp__docs__read',input:{page:'overview'}},
  ...(status==='pending'?{liveOutput:'Loading documentation…'}:{result:{type:'tool_result',tool_use_id:id,content:'Documentation output for '+id}})});
const fixtureStartedAt=Date.now()-16000;
const model = (entries, running=true, durationMs) => ({state:running?'running':'completed',title:'Working',summary:'Work',entries,previewEntries:entries,
  toolCount:entries.filter(e=>e.type==='tool').length,noteCount:entries.filter(e=>e.type==='thinking'||e.type==='note').length,
  hiddenEntryCount:0,startedAt:fixtureStartedAt,durationMs,todoProgress:null});
function App(){
 const [timing,setTiming]=useState(null);
 const [detailStatus,setDetailStatus]=useState('pending');
 const [n,setN]=useState(10),[running,setRunning]=useState(true),[turn,setTurn]=useState(1),[states,setStates]=useState(false),[chat,setChat]=useState(false),[recording,setRecording]=useState(false);
 window.qa={recording:()=>{setRecording(true);setChat(false)},newClockTurn:()=>store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],status:'running',messages:[...s.sessions[chatId].messages,{...prompt,createdAt:Date.now()},{...thought,uuid:'next-thought',createdAt:Date.now()}]}}})),summary:setTiming,detailStatus:setDetailStatus,chat:()=>{store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],messages:s.sessions[chatId].messages.map(m=>m===prompt?{...m,createdAt:Date.now()-16000}:m)}}}));setChat(true)},store,chatId,
  imageTurn:(provider,stage)=>{
   const imageTool={type:'assistant',uuid:'image-tool',createdAt:1200,message:{content:[{type:'tool_use',id:'image-edit',name:'image_edit',input:{prompt:'Make the cat white',__aegisGeneratedMedia:[{kind:'image',path:'/tmp/white-cat.png'}]}}]}};
   const imageResult={type:'user',uuid:'image-result',createdAt:1400,message:{content:[{type:'tool_result',tool_use_id:'image-edit',content:'/tmp/white-cat.png'}]}};
   const reply={type:'assistant',uuid:'image-reply',createdAt:1800,streaming:stage==='streaming',...(provider==='codex'?{phase:'final_answer'}:{}),message:{content:[{type:'text',text:'The cat is now white. The pose and background are unchanged.'}]}};
   const messages=[prompt,{...thought,uuid:provider+'-image-thought'},imageTool,imageResult,...(stage==='generated'?[]:[reply]),...(stage==='completed'?[{type:'result',subtype:'success',duration_ms:19000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}}]:[])];
   store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],provider,status:stage==='completed'?'completed':'running',messages}}}));
  },
  stopThinking:()=>store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],messages:[prompt,thought],status:'completed'}}})),
  answer:(text='The project is ready.')=>emit({type:'assistant',uuid:'answer',createdAt:2000,streaming:true,phase:'final_answer',message:{content:[{type:'text',text}]}}),
  complete:()=>{emit({type:'assistant',uuid:'answer',createdAt:2000,streaming:false,phase:'final_answer',message:{content:[{type:'text',text:'The project is ready.'}]}});emit({type:'result',subtype:'success',duration_ms:44000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});store.setState(s=>({sessions:{...s.sessions,[chatId]:{...s.sessions[chatId],status:'completed'}}}));},
  states:()=>setStates(true),advance:()=>setN(n+1),finish:()=>setRunning(false),newTurn:()=>{setTurn(turn+1);setRunning(true)},
   reduced:()=>useAppPreferences.setState({reduceMotion:'on'}),
   dark:()=>useAppStore.getState().setTheme('dark')};
 const entries=Array.from({length:n},(_,i)=>tool('step-'+i,running&&i===n-1?'pending':'success'));
 if(recording && !timing) {
  const recordedRead=id=>({...tool(id),toolName:'Read',kind:'file_read',summary:'Read '+id,block:{type:'tool_use',id,name:'Read',input:{file_path:'/tmp/'+id}}});
  const recordedCommand=(id,command)=>({...tool(id),toolName:'Bash',kind:'command_execution',summary:'Ran '+command,block:{type:'tool_use',id,name:'Bash',input:{command}}});
  const recordedSearch=(id,pattern,file)=>({...tool(id),toolName:'Grep',kind:'pattern_search',summary:'Searched for '+pattern+' in '+file,block:{type:'tool_use',id,name:'Grep',input:{pattern,path:file}}});
  const recorded=[recordedSearch('search','coworker|Profile|profile','MEMORY.md'),
   recordedCommand('command',"pwd; rg -n 'Display name|displayName|display_name' src electron --glob '!**/node_modules/**'"),
   ...['user-profile.ts','ProfileSettingsGroup.tsx','useUserProfile.ts'].map(recordedRead),
   recordedSearch('search-2','getUserProfile|saveUserProfile|function initialsOf|function avatarColor|AEGIS_CONFIG','src'),
   recordedRead('MEMORY.md'),recordedCommand('command-2','for profile_file in "$HOME/Library/Application Support/aegis/user-profile.json"; do cat "$profile_file"; done'),
   recordedCommand('command-3',"nl -ba src/ui/utils/user-avatars.ts; rg -n 'setPath|userData' src/electron")];
  return <main id="recording" style={{maxWidth:884,margin:'auto',padding:'32px 0',fontSize:16}}><WorkstreamDisclosure model={model([{id:'preamble',type:'note',summary:'我先定位这个 Profile 页的代码，沿着 Display name 和 Handle 的来源看一下读取、默认值和保存逻辑。'},...recorded],false,40000)} isRunning={false}/><p>截图里的 BubbleBrain 是从本地保存的 Profile 配置读取的。</p></main>;
 }
 if(timing) return <div id="timing"><ActivitySummary summaryKey={timing.key} immediate={timing.immediate}><WorkstreamActivityLabel active={!timing.immediate}>{timing.label}</WorkstreamActivityLabel></ActivitySummary></div>;
 if(chat) return <div id="real-chat" style={{height:'100vh',display:'flex'}}><ChatPane paneId="qa" sessionId={chatId} isActive onActivate={()=>{}} codexModelConfig={config} /></div>;
 if(states) return <main>
   <section id="denied"><WorkstreamDisclosure model={model([{id:'denied',type:'approval',summary:'Delete denied',detail:'User declined deletion',state:'denied'}],false,12000)} isRunning={false}/></section>
   <section id="recovered"><WorkstreamDisclosure model={model([tool('cancelled','interrupted'),tool('retried')],false,12000)} isRunning={false} allowCollapse/></section>
   <section id="stopped"><WorkstreamDisclosure model={model([tool('stopped','interrupted')],false)} isRunning={false}/></section>
   <section id="waiting"><WorkstreamDisclosure model={model([tool('done'),{id:'permission',type:'approval',summary:'Waiting for approval',detail:'Allow reading the selected directory',state:'waiting'}])} isRunning/></section>
   <section id="error"><WorkstreamDisclosure model={model([tool('ok'),tool('failed','error')])} isRunning/></section>
   <section id="shell"><WorkstreamDisclosure model={model([{...tool('shell','pending'),toolName:'Bash',kind:'command_execution',summary:'Running npm test',block:{type:'tool_use',id:'shell',name:'Bash',input:{command:'npm test'}},liveOutput:'Running test suite…'}])} isRunning/></section>
 </main>;
 return <main style={{maxWidth:780,padding:'24px 32px',margin:'auto',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
  <section id="completed"><h3>Completed turn</h3><WorkstreamDisclosure model={model([tool('finished')],false,44000)} isRunning={false}/><p>The implementation is ready for review.</p></section>
  <section id="thinking"><h3>Reasoning</h3><WorkstreamDisclosure model={model([{id:'thought',type:'thinking',summary:'Compare the two implementations',detail:'**Compare the two implementations**\\nInspect the event lifecycle before changing the renderer.',state:'active'}])} isRunning defaultExpanded/></section>
  <section id="repeated"><h3>Consecutive MCP calls</h3><WorkstreamDisclosure model={model([tool('repeat-a'),{...tool('repeat-b'),summary:tool('repeat-a').summary}],false)} isRunning={false} defaultExpanded/></section>
  <section id="mcp"><h3>Successful tool</h3><WorkstreamDisclosure model={model([tool('mcp')],false)} isRunning={false} defaultExpanded/></section>
  <section id="thought-tool"><WorkstreamDisclosure model={model([{id:'previous-thought',type:'thinking',summary:'Earlier reasoning',state:'complete'},tool('one-tool')],false)} isRunning={false} defaultExpanded/></section>
  <section id="heading-fallback"><WorkstreamDisclosure model={model([{id:'heading',type:'thinking',summary:'**Checking the runtime**',state:'complete'},{id:'boundary',type:'note',summary:'Now running the check'},tool('after-note')])} isRunning/></section>
  <section id="detail-lifecycle"><WorkstreamDisclosure model={model([tool('stable-details',detailStatus)],detailStatus==='pending')} isRunning={detailStatus==='pending'} defaultExpanded/></section>
  <section id="unknown-clock"><WorkstreamDisclosure model={{...model([tool("unknown-clock","pending")]),startedAt:undefined}} isRunning/></section>
  <section id="pending-read"><WorkstreamDisclosure model={model([{...tool('pending-read','pending'),toolName:'Read',kind:'file_read',summary:'Reading pending.ts',block:{type:'tool_use',id:'pending-read',name:'Read',input:{file_path:'/tmp/pending.ts'}}}])} isRunning/></section>
  <section id="reads"><WorkstreamDisclosure model={model(['one','two'].map(id=>({...tool(id),toolName:'Read',kind:'file_read',summary:'Read '+id+'.ts',block:{type:'tool_use',id,name:'Read',input:{file_path:'/tmp/'+id+'.ts'}}})),false)} isRunning={false} defaultExpanded/></section>
  <section id="reset"><h3>Explicit disclosure choice</h3><WorkstreamDisclosure model={model(entries,running,running?undefined:44000)} isRunning={running} defaultExpanded={running} resetKey={'turn:'+turn}/></section>
  <section id="auto"><h3>Lifecycle default</h3><WorkstreamDisclosure model={model([tool('auto',running?'pending':'success')],running,44000)} isRunning={running} defaultExpanded={running} resetKey={'turn:'+turn}/></section>
 </main>;
}
createRoot(document.getElementById('root')).render(<Tooltip.Provider><App/></Tooltip.Provider>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(process.env.QA_DATA_DIR,'profile'));
app.setPath('sessionData',path.join(process.env.QA_DATA_DIR,'session-data'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1000,height:980,show:true});
 const errors=[];w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const js=async s=>{try{return await w.webContents.executeJavaScript(s,true)}catch(e){console.error('Failed expression:',s,errors);throw e}};
 const until=async(s,label)=>{for(let i=0;i<60;i++){if(await js(s))return;await delay(100)}throw Error('Timed out: '+label)};
 const click=async(s)=>{await js('document.querySelector('+JSON.stringify(s)+').click()');await delay(320);await until('!document.querySelector(".workstream-activities [inert][aria-hidden=true]")','disclosure exit animation settles')};
 const expanded=s=>js('document.querySelector('+JSON.stringify(s)+'+" .workstream-toggle-row button").getAttribute("aria-expanded")');
 const shot=async(name)=>{fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 try{
  await w.loadURL(process.env.QA_URL);await until('!!window.qa','renderer');await delay(500);
  assert.equal(await expanded('#completed'),'false');
  assert(await js('document.querySelector("#completed [data-workstream-divider]").getBoundingClientRect().top >= document.querySelector("#completed .workstream-toggle-row button").getBoundingClientRect().bottom'),'divider sits below Worked for');
  assert.equal(await js('document.querySelector("#completed .workstream-toggle-row button").textContent'),'Worked for 44s');
  assert.equal(await js('document.querySelector("#mcp .workstream-toggle-row button").textContent'),'1 previous message','unknown duration never uses Date.now');
  assert.equal(await js('document.querySelectorAll("#thinking .workstream-toggle-row button[aria-expanded]").length'),0,'running trace has no whole-turn collapse');
  assert.equal(await js('document.querySelector("#unknown-clock [data-workstream-time]").textContent'),'Working','unknown start has no invented elapsed time');
  assert.equal(await js('document.querySelectorAll("#thinking [aria-expanded]").length'),0,'reasoning alone has no fabricated activity disclosure');
  assert.equal(await js('document.querySelector("#thinking [data-thinking-footer] .workstream-activity-label").firstChild.textContent'),'Compare the two implementations');
  assert.equal(await js('!!document.querySelector("#mcp button[disabled]")'),false);
  assert.equal(await js('document.querySelectorAll("#mcp [data-workstream-group]").length'),0,'one completed activity has no redundant group');
  assert.equal(await js('document.querySelectorAll("#thought-tool [data-workstream-group]").length'),0,'reasoning does not add a wrapper to one completed tool');
  assert.equal(await js('document.querySelectorAll("#thought-tool [data-workstream-stage]").length'),1,'completed tool remains directly inspectable');
  assert.equal(await js('document.querySelectorAll("#thought-tool [data-reasoning-detail]").length'),0,'tool details do not append unrelated reasoning');
  assert.equal(await js('[...document.querySelectorAll("#heading-fallback [data-workstream-group] .workstream-activity-label")].at(-1).firstChild.textContent'),'Checking the runtime','latest group inherits the turn reasoning heading across narration');
  assert.equal(await js('document.querySelectorAll("#heading-fallback [data-workstream-group]").length'),1,'prior reasoning creates no empty historical group');
  assert.equal(await js('document.querySelector("#pending-read [data-workstream-group]").hasAttribute("aria-expanded")'),false,'unfinished exploration has no empty disclosure');
  await click('#reads [data-workstream-group]');
  assert.deepEqual(await js('[...document.querySelectorAll("#reads [data-exploration-detail]")].map(e=>e.textContent)'),['Read one.ts','Read two.ts'],'completed reads are individual native detail rows');
  assert.equal(await js('document.querySelectorAll("#reads [data-exploration-detail] [aria-expanded]").length'),0,'completed read rows do not add a nested disclosure');
  await click('#reads [data-agent-activity-file-link]');
  assert.equal(await js('qa.store.getState().pendingProjectFileOpen?.path'),'/tmp/one.ts','read filename directly opens the correct project file');
  await click('#detail-lifecycle [data-workstream-group]');
  await click('#detail-lifecycle [data-workstream-stage] > button');
  await js('qa.detailStatus("success")');await delay(350);
  assert.equal(await js('document.querySelector("#detail-lifecycle [data-workstream-stage] > button").getAttribute("aria-expanded")'),'true','open details survive completion and group unwrapping');
  await click('#detail-lifecycle [data-workstream-stage] > button');
  await js('qa.detailStatus("error")');await delay(350);
  assert.equal(await js('document.querySelector("#detail-lifecycle [data-workstream-stage] > button").getAttribute("aria-expanded")'),'false','closed details survive a status-derived stage kind change');
  await click('#repeated [data-workstream-group]');
  assert((await js('document.querySelector("#repeated [data-workstream-stage]").textContent')).includes('2 calls'));
  await click('#repeated [data-workstream-stage] > button');
  assert((await js('document.querySelector("#repeated").innerText')).includes('Documentation output for repeat-a'));
  assert((await js('document.querySelector("#repeated").innerText')).includes('Documentation output for repeat-b'),'merged calls preserve every result');
  await click('#mcp [data-workstream-stage] > button');
  assert((await js('document.querySelector("#mcp").innerText')).includes('Documentation output for mcp'));
  await click('#mcp [aria-label="Show raw tool call output"]');
  assert((await js('document.querySelector("[role=dialog]").innerText')).includes('overview'));
  await click('[aria-label="Close raw output"]');
  await click('#reset [data-workstream-group]');
  assert.equal(await js('document.querySelectorAll("#reset [data-workstream-stage]").length'),10,'all stages retained');
  assert.equal(await js('document.querySelectorAll("#reset [data-workstream-stage] .workstream-activity-shimmer").length'),0,'group details suppress duplicate active shimmer');
  assert.equal(await js('getComputedStyle(document.querySelector("#reset .workstream-activities")).rowGap'),'16px','native activity item spacing');
  assert.equal(await js('getComputedStyle(document.querySelector("#reset .workstream-scroll-area > div")).rowGap'),'4px','native grouped item spacing');
  assert.equal(await js('(()=>{const a=document.querySelector("#reset .workstream-scroll-area"),r=a.getBoundingClientRect(),last=a.lastElementChild.lastElementChild.getBoundingClientRect();return last.bottom<=r.bottom+1&&last.top>=r.top})()'),true,'latest pending stage visible');
  assert.equal(await js('document.querySelector("#reset .workstream-scroll-area").scrollHeight>document.querySelector("#reset .workstream-scroll-area").clientHeight'),false,'recorded native variant does not truncate activity rows');
  await js('document.querySelector("#reset .workstream-scroll-area").scrollTop=0');await delay(100);
  await js('qa.advance()');await delay(200);
  assert.equal(await js('document.querySelector("#reset .workstream-scroll-area").scrollTop'),0,'reader scrolling into history is respected');
  await click('#reset [data-workstream-group]');
  await js('qa.advance()');await delay(200);
  assert.equal(await js('document.querySelector("#reset [data-workstream-group]").getAttribute("aria-expanded")'),'false','new messages preserve group collapse');
  await click('#reset [data-workstream-group]');
  await click('#mcp .workstream-toggle-row button');
  await js('qa.advance()');await delay(200);assert.equal(await expanded('#mcp'),'false','new messages preserve turn collapse');
  await click('#mcp .workstream-toggle-row button');
  assert.equal(await js('document.querySelector("#mcp [data-workstream-stage] > button").getAttribute("aria-expanded")'),'true','tool choice survives hiding the whole trace');
  await js('qa.finish()');await delay(320);
  assert.equal(await expanded('#mcp'),'true','explicit expansion survives rerender');
  assert.equal(await expanded('#auto'),'false','untouched trace collapses on completion');
  await js('qa.newTurn()');await delay(320);
  assert.equal(await js('document.querySelectorAll("#auto .workstream-toggle-row button[aria-expanded]").length'),0,'next running turn is open');
  await click('#reset [data-workstream-group]');
  await shot('light');
  const lightBg=await js('getComputedStyle(document.querySelector("main")).backgroundColor');
  await js('qa.dark()');await delay(150);await shot('dark');
  assert.notEqual(await js('getComputedStyle(document.querySelector("main")).backgroundColor'),lightBg,'dark theme actually changes the palette');
  w.setContentSize(390,850);await delay(200);await shot('narrow');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'no horizontal overflow');
  await js('qa.reduced()');await delay(150);
  assert.equal(await js('document.querySelectorAll(".workstream-activity-shimmer").length'),0,'app reduced motion disables shimmer');
  // Native keyboard interaction uses the same disclosure button.
  app.focus({steal:true});w.show();w.focus();w.webContents.focus();
  await js('document.querySelector("#completed .workstream-toggle-row button").focus()');await delay(100);
  w.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});w.webContents.sendInputEvent({type:'char',keyCode:'\r'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await delay(150);
  assert.equal(await expanded('#completed'),'true');
  await js('qa.states()');await delay(320);
  assert.equal(await expanded('#denied'),'false');
  assert.equal(await js('document.querySelector("#denied [data-denied-action-count]").textContent'),'1 action denied');
  await click('#denied [data-denied-action-count]');
  assert((await js('document.querySelector("#denied").innerText')).includes('User declined deletion'),'denied-action summary opens its explanation');
  assert.equal(await expanded('#recovered'),'false','completed final answer can collapse after an earlier interrupted tool');
  assert.equal(await js('document.querySelectorAll("#stopped .workstream-toggle-row").length'),0,'stopped work is not presented as a completed collapsed turn');
  assert((await js('document.querySelector("#waiting").innerText')).includes('Waiting for approval'),'approval is a visible standalone event');
  assert.equal(await js('document.querySelector("#error [data-workstream-group]").getAttribute("aria-expanded")'),'false','error group stays collapsed while the agent is working');
  assert.equal(await js('document.querySelector("#error [data-workstream-group]").textContent'),'Thinking(1 failed)','live group falls back to thinking while retaining failure count');
  await click('#error [data-workstream-group]');
  assert.equal(await js('document.querySelector("#error [data-workstream-stage=\\"stage:error:failed\\"] > button").getAttribute("aria-expanded")'),'false','failed tool details stay collapsed');
  assert((await js('document.querySelector("#error [data-workstream-stage=\\"stage:error:failed\\"] > button").textContent')).endsWith('(1 failed)'));
  assert(!(await js('document.querySelector("#error").innerText')).includes('Documentation output for failed'));
  await shot('error-collapsed');
  await click('#error [data-workstream-stage="stage:error:failed"] > button');
  assert((await js('document.querySelector("#error").innerText')).includes('Documentation output for failed'));
  await click('#error [data-workstream-stage="stage:error:failed"] > button');
  assert(!(await js('document.querySelector("#error").innerText')).includes('Documentation output for failed'));
  assert.equal(await js('document.querySelector("#shell [data-workstream-group]").getAttribute("aria-expanded")'),'false','running shell stays collapsed by default');
  assert(!(await js('document.querySelector("#shell").innerText')).includes('$ npm test'));
  await click('#shell [data-workstream-group]');
  await click('#shell [data-workstream-stage] > button');
  assert((await js('document.querySelector("#shell").innerText')).includes('$ npm test'),'running shell details can be opened manually');
  assert((await js('document.querySelector("#shell").innerText')).includes('Running test suite…'),'streamed command output remains visible');
  await click('#shell [data-workstream-group]');
  assert(!(await js('document.querySelector("#shell").innerText')).includes('$ npm test'));
  await shot('shell-collapsed');
  w.setContentSize(1100,850);
  await js('qa.chat()');await until('!!document.querySelector("#real-chat")','actual ChatPane');await delay(500);
  assert.equal(await js('document.querySelectorAll("#real-chat .workstream-toggle-row button[aria-expanded]").length'),0,'real running ChatPane keeps activity inline');
  assert.equal(await js('document.querySelector("#real-chat [data-activity-state]").dataset.activityState'),'active','trailing exploration remains active between reads');
  const liveSeconds=()=>js('Number(document.querySelector("#real-chat [data-workstream-time]").textContent.match(/([0-9]+)s/)[1])');
  const initialSeconds=await liveSeconds();assert(initialSeconds>=16&&initialSeconds<=18,'clock starts at the prompt timestamp');
  await shot('chat-running-clock');
  await until('(document.querySelector("#real-chat [data-workstream-time]").textContent.match(/([0-9]+)s/)[1]|0)>'+initialSeconds,'whole-turn clock advances');
  const beforeAnswerSeconds=await liveSeconds();
  await js('qa.answer()');await delay(320);
  assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").getAttribute("aria-expanded")'),'false','native final-answer signal collapses in the actual ChatPane');
  assert((await js('document.querySelector("#real-chat").innerText')).includes('The project is ready.'));
  await js('qa.answer(" More details.")');
  await until('(document.querySelector("#real-chat [data-workstream-time]").textContent.match(/([0-9]+)s/)[1]|0)>'+beforeAnswerSeconds,'collapsed clock advances through final-answer tokens');
  assert((await js('document.querySelector("#real-chat [data-workstream-time]").textContent')).startsWith('Working for '));
  await shot('chat-streaming-clock');
  await js('qa.complete()');await delay(350);
  assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").textContent'),'Worked for 44s');
  await delay(1100);
  assert.equal(await js('document.querySelector("#real-chat [data-workstream-time]").textContent'),'Worked for 44s','recorded provider duration freezes and overrides the live estimate');
  await click('#real-chat .workstream-toggle-row button');await shot('chat-expanded-dark');
  const conversationSizes=()=>js('(()=>{const font=s=>getComputedStyle(document.querySelector(s)).fontSize;return [font("#real-chat .assistant-response-markdown p"),font("#real-chat .workstream-text")]})()');
  assert.deepEqual(await conversationSizes(),['13px','13px'],'reply and trace share the conversation font size');
  await js('document.documentElement.style.setProperty("--ui-font-scale","1.25")');
  assert.deepEqual(await conversationSizes(),['16.25px','16.25px'],'reply and trace scale together');
  await js('document.documentElement.style.removeProperty("--ui-font-scale")');
  await js('qa.store.getState().setTheme("light")');await delay(150);await shot('chat-expanded-light');
  w.setContentSize(390,850);await delay(200);await shot('chat-narrow');
  assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'actual ChatPane has no narrow overflow');
  await js('qa.newClockTurn()');await delay(350);
  assert.equal(await js('[...document.querySelectorAll("#real-chat [data-workstream-time]")].at(-1).textContent'),'Working','new turn owns a new stable clock');
  await until('[...document.querySelectorAll("#real-chat [data-workstream-time]")].at(-1).textContent.startsWith("Working for ")','new turn clock advances');
  assert.equal(await js('document.querySelector("#real-chat [data-workstream-time]").textContent'),'Worked for 44s','history stays frozen while the next turn ticks');
  await js('qa.stopThinking()');await delay(350);
  assert.equal(await js('document.querySelectorAll("#real-chat .workstream-toggle-row").length'),0,'stopping during thinking keeps the real trace visible');
  assert.equal(await js('document.querySelectorAll("#real-chat [data-thinking-footer], #real-chat [data-workstream-group]").length'),0,'stopped reasoning leaves no phantom live or historical activity row');
  await js('qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:qa.chatId,status:"error"}});qa.store.getState().handleServerEvent({type:"runner.error",payload:{sessionId:qa.chatId,message:"Agent connection closed"}})');await delay(150);
  assert((await js('document.querySelector("[data-turn-failure]").textContent')).includes('Agent connection closed'));
  await shot('chat-interrupted');
  await js('qa.store.getState().handleServerEvent({type:"session.status",payload:{sessionId:qa.chatId,status:"running"}})');await delay(150);
  assert.equal(await js('document.querySelector("[data-turn-failure]")===null'),true,'new turn clears the failure notice');
  assert.equal(await js('qa.store.getState().sessions[qa.chatId].lastTurnError'),undefined);
  w.setContentSize(1000,850);
  for(const provider of ['grok','codex']){
   await js('qa.imageTurn('+JSON.stringify(provider)+',"generated")');
   await until('document.querySelectorAll("#real-chat img[alt=\\"white-cat.png\\"]").length===1','image appears before reply');
   for(const stage of ['streaming','completed']){
    await js('qa.imageTurn('+JSON.stringify(provider)+','+JSON.stringify(stage)+')');await delay(350);
    await until('document.querySelectorAll("#real-chat img[alt=\\"white-cat.png\\"]").length===1','one image throughout completion');
    assert(await js('(()=>{const image=document.querySelector("#real-chat img[alt=\\"white-cat.png\\"]"),reply=[...document.querySelectorAll("#real-chat p")].find(p=>p.textContent.startsWith("The cat is now white."));return !!reply&&image.getBoundingClientRect().bottom<=reply.getBoundingClientRect().top})()'),provider+' '+stage+': image stays above reply');
    await shot('image-order-'+provider+'-'+stage);
   }
   assert.equal(await js('document.querySelector("#real-chat .workstream-toggle-row button").getAttribute("aria-expanded")'),'false','completed image turn collapses');
   await click('#real-chat .workstream-toggle-row button');
   assert.equal(await js('document.querySelectorAll("#real-chat img[alt=\\"white-cat.png\\"]").length'),1,'opening trace does not duplicate image');
  }
  await js('qa.recording();qa.store.getState().setTheme("light")');w.setContentSize(1100,900);await delay(350);
  await shot('recording-completed');
  await click('#recording .workstream-toggle-row button');
  assert(await js('!!document.querySelector("#recording [data-workstream-group] svg")'),'completed group has representative icon');
  assert.equal(await js('document.querySelector("#recording [data-workstream-group]").textContent'),'Explored project, ran commands','mixed exploration has a matching project summary');
  await click('#recording [data-workstream-group]');
  assert.equal(await js('document.querySelectorAll("#recording [data-workstream-stage]").length'),9);
  assert.deepEqual(await js('(()=>{const rows=[...document.querySelectorAll("#recording [data-workstream-stage]")];return rows.slice(1).map((e,i)=>e.getBoundingClientRect().top-rows[i].getBoundingClientRect().top)})()'),Array(8).fill(23.5),'conversation typography uses a 19.5px line with 4px separation');
  assert.equal(await js('getComputedStyle(document.querySelector("#recording .workstream-text")).fontSize'),'13px');
  assert.equal(await js('document.querySelector("#recording .workstream-scroll-area").scrollHeight>document.querySelector("#recording .workstream-scroll-area").clientHeight'),false,'nine recorded rows remain fully visible');
  assert.equal(await js('document.querySelectorAll("#recording [data-workstream-stage]")[1].querySelector("button").querySelectorAll("svg").length'),1,'successful command row has its icon without an extra chevron');
  await shot('recording-expanded');
  // Actual timers and React DOM identity: token events must not restart animation or starve the trailing update.
  await js('qa.summary({key:"active:a",label:"Reading A",immediate:false})');await delay(100);
  await js('window.firstLabel=document.querySelector("#timing .workstream-activity-label");qa.summary({key:"active:a",label:"Reading A updated",immediate:false})');await delay(50);
  assert(await js('document.querySelector("#timing .workstream-activity-label")===firstLabel'),'same activity reuses its label DOM');
  assert((await js('document.querySelector("#timing").innerText')).includes('Reading A updated'));
  for(let i=0;i<5;i++){await js('qa.summary({key:"active:b",label:"Reading B '+i+'",immediate:false})');await delay(90)}
  assert((await js('document.querySelector("#timing").innerText')).includes('Reading A'),'activity holds its one-second minimum');
  await until('document.querySelector("#timing").innerText.includes("Reading B 4")','latest pending summary commits');
  await js('qa.summary({key:"thinking",label:"Thinking",immediate:false})');await delay(50);
  await js('qa.summary({key:"summary",label:"Read two files",immediate:true})');await delay(50);
  assert((await js('document.querySelector("#timing").innerText')).includes('Read two files'),'terminal summary bypasses delay');
  await delay(1100);
  assert((await js('document.querySelector("#timing").innerText')).includes('Read two files'),'obsolete deferred update is cancelled');
  assert.deepEqual(errors,[],'renderer console errors');
  console.log('workstream disclosure: lifecycle, reasoning, tool output, scrolling, keyboard and themes passed');app.exit(0);
 }catch(e){console.error(e);await shot('failure');app.exit(1)}
});
`;
try {
 await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0;background:var(--bg-primary)"><div id="root"></div><script type="module" src="./probe.tsx"></script></body></html>');
 await writeFile(path.join(dir,'probe.tsx'),harness);
 await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dataDir,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false}});
 await server.listen();
 const env={...process.env,QA_DATA_DIR:dataDir,BUBBLE_HOME:path.join(dataDir,'agent-home'),BUBBLE_DESKTOP_PROFILE:'qa',BUBBLE_DESKTOP_USER_DATA:path.join(dataDir,'profile'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'artifacts/codex-trace')};
 delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});
  const timeout=setTimeout(()=>{child.kill();reject(Error('Electron test timed out'))},60000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('Electron test failed: '+code))});
 });
} finally { await server?.close();await rm(dir,{recursive:true,force:true});await rm(dataDir,{recursive:true,force:true}); }

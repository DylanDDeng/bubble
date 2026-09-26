import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root=process.cwd();
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/composer-overflow-'));
const harness=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {NewSessionView} from '/src/ui/components/NewSessionView';
import {ComposerPendingPermissionPanel} from '/src/ui/components/ComposerPendingPermissionPanel';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.electron={getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],listCodexSkills:async()=>({skills:[]}),sendClientEvent:()=>{}};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/composer-qa');
store.setState(s=>({connected:true,projectCwd:'/tmp/composer-qa',activeSessionId:id,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'bubble',status:'completed',messages:[],hydrated:true}}}));
const questions=Array.from({length:3},(_,i)=>({header:'Question '+(i+1),question:'Choose UI state, color or music '+(i+1),multiSelect:i===1,options:Array.from({length:4},(_,j)=>({label:'Option '+(i+1)+'-'+(j+1),description:'A detailed option explaining the animation, color and timing. '.repeat(5)}))}));
const request={sessionId:id,toolUseId:'question',toolName:'AskUserQuestion',input:{questions}};
window.qa={store,id,answers:[]};
function Harness(){const [mode,setMode]=useState('new');qa.mode=setMode;
return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:'var(--bg-primary)',color:'var(--text-primary)'}}><header style={{height:56,flexShrink:0}}>Bubble composer layout QA</header>
{mode==='new'?<NewSessionView/>:<><main style={{flex:1,minHeight:0,overflow:'auto'}}>Conversation content</main><div className="aegis-chat-composer px-8 pb-4"><PromptInput sessionId={id} approvalPending={mode==='question'} approvalPanel={<ComposerPendingPermissionPanel request={request} pendingCount={1} onSubmit={(tool,result)=>qa.answers.push({tool,result})}/>}/></div></>}
</div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:800,show:true,webPreferences:{backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s,true);
 const until=async(s,label)=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(50)}throw Error('Timed out: '+label)};
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const shot=async name=>{win.webContents.invalidate();await delay(150);fs.mkdirSync(process.env.QA_CAPTURE,{recursive:true});fs.writeFileSync(path.join(process.env.QA_CAPTURE,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 try{
 await win.loadURL(process.env.QA_URL);await until('!!document.querySelector("[role=textbox]")','composer');
 const text=Array.from({length:90},(_,i)=>'Line '+i+': Keep the entire long prompt in the editor. 中文长文本，不转换成附件。').join('\n');
 for(const mode of ['new','chat']){
  await js('qa.mode('+JSON.stringify(mode)+')');await delay(100);
  await js('(()=>{const e=document.querySelector("[role=textbox]");e.focus();const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(text)+');e.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
  await until('document.querySelector("[role=textbox]").textContent.includes("Line 89")','full paste');
  for(const [width,height] of [[1000,800],[540,420]]){
   win.setContentSize(width,height);await delay(100);
   await js('(()=>{const landing=document.querySelector(".aegis-new-thread-landing");if(landing)landing.scrollTop=landing.scrollHeight})()');
   const m=await js('(()=>{const e=document.querySelector("[role=textbox]"),r=e.getBoundingClientRect(),t=document.querySelector(".aegis-composer-toolbar").getBoundingClientRect();e.scrollTop=0;return {height:r.height,scroll:e.scrollHeight,client:e.clientHeight,overflow:getComputedStyle(e).overflowY,bottom:r.bottom,toolbarTop:t.top,toolbarBottom:t.bottom,screen:innerHeight,pageOverflow:document.documentElement.scrollHeight>innerHeight}})()');
   assert.equal(m.overflow,'auto');assert(m.scroll>m.client);assert(m.height<=200);assert(m.bottom<=m.toolbarTop,'text clears toolbar');assert(m.toolbarBottom<=m.screen,'toolbar in view');assert.equal(m.pageOverflow,false);
   await js('document.querySelector("[role=textbox]").scrollTop=99999');assert(await js('document.querySelector("[role=textbox]").scrollTop>0'),'scroll to last line');
  }
  await js('(()=>{const landing=document.querySelector(".aegis-new-thread-landing");if(landing)landing.scrollTop=landing.scrollHeight})()');
  await shot(mode+'-long-prompt');
  await js('document.querySelector("[role=textbox]").scrollTop=0');
  await shot(mode+'-long-prompt-top');
 }
 await js('qa.mode("question")');await until('!!document.querySelector("[data-decision-questions]")','questions');
 for(const [width,height] of [[1000,800],[540,420],[390,360]]){
  win.setContentSize(width,height);await delay(100);
  const m=await js('(()=>{const q=document.querySelector("[data-decision-questions]"),p=document.querySelector("[data-composer-permission-panel]"),b=[...p.querySelectorAll("button")].find(b=>b.textContent==="Submit");q.scrollTop=0;return {scroll:q.scrollHeight,client:q.clientHeight,top:p.getBoundingClientRect().top,bottom:p.getBoundingClientRect().bottom,button:b.getBoundingClientRect().toJSON(),screen:innerHeight}})()');
  assert(m.scroll>m.client&&m.client>0,'questions have usable inner scroller');assert(m.top>=56&&m.bottom<=m.screen,'card within chat');assert(m.button.bottom<=m.screen,'Submit visible');
  await js('document.querySelector("[data-decision-questions]").scrollTop=99999');
  const after=await js('({scroll:document.querySelector("[data-decision-questions]").scrollTop,y:[...document.querySelectorAll("button")].find(b=>b.textContent==="Submit").getBoundingClientRect().y})');
  assert(after.scroll>0);assert.equal(after.y,m.button.y,'Submit fixed while scrolling');
 }
 await js('document.querySelectorAll("[data-decision-questions] button")[0].click()');await delay(50);
 await js('document.querySelectorAll("[data-decision-questions] button")[4].click()');await delay(50);
 await js('document.querySelectorAll("[data-decision-questions] button")[5].click()');await delay(50);
 await js('(()=>{const e=document.querySelectorAll("[data-decision-questions] input")[2];e.focus();e.scrollIntoView({block:"nearest"})})()');await win.webContents.insertText('Use my music');await delay(100);await shot('scrollable-question');
 const button=await js('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent==="Submit"),r=b.getBoundingClientRect();return {disabled:b.disabled,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 assert.equal(button.disabled,false);win.webContents.sendInputEvent({type:'mouseDown',button:'left',x:button.x,y:button.y,clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',button:'left',x:button.x,y:button.y,clickCount:1});
 await until('qa.answers.length===1','visible Submit responds');const a=await js('qa.answers[0]');assert.equal(a.tool,'question');assert.equal(a.result.behavior,'allow');assert.deepEqual(Object.values(a.result.updatedInput.answers),['Option 1-1','Option 2-1,Option 2-2','Use my music']);
 assert.deepEqual(errors,[]);console.log('PASS: long pasted prompts scroll in new/chat composers; constrained questions keep clickable Submit and all answers');app.exit(0);
 }catch(e){console.error(e,errors);await shot('failure');app.exit(1)}
});
`;
let server;
try{
 await writeFile(path.join(dir,'index.html'),'<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
 await writeFile(path.join(dir,'harness.tsx'),harness);await writeFile(path.join(dir,'main.cjs'),main);
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.aegis-design-qa/**']}}});await server.listen();
 const env={...process.env,BUBBLE_HOME:path.join(dir,'bubble-home'),QA_URL:new URL(path.relative(root,dir)+'/index.html',server.resolvedUrls.local[0]).href,QA_CAPTURE:path.join(root,'output/playwright/composer-overflow')};delete env.ELECTRON_RUN_AS_NODE;
 await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/.bin/electron'),[path.join(dir,'main.cjs')],{env,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('Composer overflow QA timed out'))},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Composer overflow QA failed: '+code))})});
}finally{await server?.close();await rm(dir,{recursive:true,force:true})}

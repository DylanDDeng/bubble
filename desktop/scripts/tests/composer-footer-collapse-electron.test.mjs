import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.aegis-design-qa/composer-footer-collapse-'));
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import {PromptInput} from '/src/ui/components/PromptInput';
import {useAppStore} from '/src/ui/store/useAppStore';
import '/src/ui/index.css';
window.electron={getProjectTree:async()=>null,cancelProjectTreeRead:async()=>{},getRecentCwds:async()=>[],getProjectGitSummary:async()=>({isGitRepository:false}),getAgentRuntimeDirectory:async()=>({checkedAt:Date.now(),entries:[]}),getSessionUserPrompts:async()=>[],getSessionGoal:async()=>({goal:null,supported:false,revision:0}),onSessionGoalChanged:()=>()=>{},getClaudeCompatibleProviderConfig:async()=>({}),getBubbleProvidersConfig:async()=>({providers:[]}),getProjectFolders:async()=>[],getModels:async()=>[],listCodexSkills:async()=>({skills:[]}),sendClientEvent:()=>{}};
for(const p of ['Claude','Kimi','Grok','Opencode','Pi','Bubble','Qoder','Deepseek','Codex'])window.electron['get'+p+'ModelConfig']=async()=>({defaultModel:null,options:[],availableModels:[]});
const store=useAppStore,id=store.getState().createDraftSession('/tmp/composer-footer-qa');
// The bubble permission pill seeds from the composer's own preference store.
localStorage.setItem('cowork.preferredBubblePermissionMode','bypassPermissions');
store.setState(s=>({connected:true,projectCwd:'/tmp/composer-footer-qa',activeSessionId:id,sessions:{...s.sessions,[id]:{...s.sessions[id],isDraft:false,provider:'bubble',status:'completed',messages:[],hydrated:true}}}));
window.qa={store,id};
// The right panel narrows the chat column, not the window. Sizing the
// composer column directly reproduces that split without a real BrowserView.
function Harness(){const [width,setWidth]=useState(760);qa.width=setWidth;
return <Tooltip.Provider><div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:'var(--bg-primary)',color:'var(--text-primary)'}}><header style={{height:56,flexShrink:0}}>Bubble composer footer QA</header>
<main style={{flex:1,minHeight:0,overflow:'auto'}}>Conversation content</main>
<div style={{width,padding:'0 16px 16px',flexShrink:0,transition:'none'}}>
<div className="aegis-chat-composer"><PromptInput sessionId={id}/></div></div>
</div></Tooltip.Provider>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1200,height:800,show:true,webPreferences:{backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s,true);
 const until=async(s,label)=>{for(let i=0;i<120;i++){if(await js(s))return;await delay(50)}throw Error('Timed out: '+label)};
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
 const probe=()=>js('(()=>{const toolbar=document.querySelector(".aegis-composer-toolbar"),btn=document.querySelector("[data-composer-control=permission]"),label=btn&&btn.querySelector("[data-composer-footer-label]"),icon=btn&&btn.querySelector("svg"),model=document.querySelector(".composer-pill-trigger"),name=model&&model.querySelector(".composer-model-name");const rect=e=>e?e.getBoundingClientRect().toJSON():null;return {toolbar:rect(toolbar),toolbarWidth:toolbar.getBoundingClientRect().width,toolbarDisplay:getComputedStyle(toolbar).containerType,btn:rect(btn),btnDisplay:btn?getComputedStyle(btn).display:null,icon:rect(icon),label:rect(label),labelDisplay:label?getComputedStyle(label).display:null,labelText:label?label.textContent.trim():null,model:rect(model),name:rect(name),nameOverflow:name?getComputedStyle(name).textOverflow:null,overflow:toolbar.scrollWidth>toolbar.clientWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth}})()');
 const load=async()=>{for(let i=0;i<3;i++){try{await win.loadURL(process.env.QA_URL);return}catch(e){if(i===2)throw e;await delay(400)}}};
 try{
  await load();
  await until('!!document.querySelector("[data-composer-control=permission]")','permission pill');
  await until('qa.labelText!==null','permission label');
  await until('!!document.querySelector(".composer-pill-trigger")','model picker');
  await delay(150);

  // Wide column: the Full Access label is present, on one line.
  const wide=await probe();
  assert.equal(wide.toolbarDisplay,'inline-size','toolbar is the inline-size container');
  assert.equal(wide.labelText,'Full Access');
  assert.notEqual(wide.labelDisplay,'none','label visible on a wide composer');
  assert(wide.label.height<=20,'label stays on one line when wide ('+Math.round(wide.label.height)+'px)');
  assert(wide.icon.width>0&&wide.icon.height>0,'shield icon present');
  assert.equal(wide.overflow,false,'toolbar does not overflow when wide');
  assert(wide.model.width<=256+2,'model trigger respects the 256px cap ('+Math.round(wide.model.width)+'px)');
  assert.equal(wide.nameOverflow,'ellipsis','model name truncates rather than pushing the row');

  // Narrow the composer column the way opening the right panel does. The
  // window stays 1200px wide, so only a container query can react.
  await js('qa.width(430)');await delay(250);
  const narrow=await probe();
  assert(narrow.toolbarWidth<520,'narrowed composer crossed the 520px step ('+Math.round(narrow.toolbarWidth)+'px)');
  assert.equal(narrow.labelDisplay,'none','label collapses to icon-only on a narrow composer');
  assert(narrow.btn.width>0&&narrow.btn.height>0,'permission control stays clickable');
  assert(narrow.icon.width>0,'shield icon survives the collapse');
  assert.equal(narrow.overflow,false,'toolbar does not overflow when narrow');
  assert.equal(narrow.pageOverflow,false,'narrowing the composer does not widen the page');
  assert(narrow.model.width>0,'model picker still visible');

  // The collapse must not have grown the toolbar: that vertical drift is the
  // baseline misalignment the wrap used to cause.
  assert(Math.abs(narrow.toolbar.height-wide.toolbar.height)<=1,'toolbar height is stable across the collapse ('+Math.round(wide.toolbar.height)+' -> '+Math.round(narrow.toolbar.height)+')');
  assert(Math.abs(narrow.btn.y-wide.btn.y)<=1,'permission control keeps its baseline');

  // Squeeze harder: nothing may wrap at any width.
  for(const w of [360,320,280,240]){
   await js('qa.width('+w+')');await delay(200);
   const m=await probe();
   assert.equal(m.overflow,false,'no toolbar overflow at '+w+'px');
   assert.equal(m.pageOverflow,false,'no page overflow at '+w+'px');
   assert(m.toolbar.height<=wide.toolbar.height+1,'toolbar never grows at '+w+'px');
   assert(m.labelDisplay==='none'||m.label.height<=20,'label never wraps at '+w+'px');
   assert(m.model.width>0&&m.btn.width>0,'both controls stay present at '+w+'px');
  }

  // Widen again: the label comes back.
  await js('qa.width(760)');await delay(250);
  const back=await probe();
  assert.equal(back.labelDisplay,'block','label returns on a wide composer');
  assert.equal(back.labelText,'Full Access');

  assert.deepEqual(errors,[],'no console errors');
  console.log('PASS: composer footer labels collapse by container width, never wrap, and keep the toolbar height stable');
  app.exit(0);
 }catch(e){console.error(e,errors);app.exit(1)}
});
`;
let server;
try {
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(dir, 'harness.tsx'), harness);
  await writeFile(path.join(dir, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(dir, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.aegis-design-qa/**'] } } });
  await server.listen();
  const env = { ...process.env, BUBBLE_HOME: path.join(dir, 'bubble-home'), QA_URL: new URL(path.relative(root, dir) + '/index.html', server.resolvedUrls.local[0]).href };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(dir, 'main.cjs')], { env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Composer footer collapse QA timed out')) }, 90000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Composer footer collapse QA failed: ' + code)) });
  });
} finally {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}

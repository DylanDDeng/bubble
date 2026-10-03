import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
await mkdir(path.join(root, '.aegis-design-qa'), { recursive: true });
const tmp = await mkdtemp(path.join(root, '.aegis-design-qa/selection-'));
const harness = `
import React, {useState, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {ComposerPromptEditor} from '/src/ui/components/ComposerPromptEditor';
import {composerEnterAction} from '/src/shared/app-preferences';
import '/src/ui/index.css';
function Harness() {
 const [draft, setDraft] = useState({value:'', cursor:0});
 const [labels, setLabels] = useState({});
 const ref = useRef(null);
 window.qa = {draft, setDraft, ref, setLabels, sends: window.qa?.sends ?? []};
 return <div style={{width:500, padding:40}}><ComposerPromptEditor ref={ref}
  value={draft.value} cursorIndex={draft.cursor} autoFocus
  slashDisplayLabels={labels}
  onChange={(value,cursor)=>setDraft({value,cursor})}
  onKeyDown={e=>{if(composerEnterAction(e,draft.value,'modifier').send){e.preventDefault();qa.sends.push(draft.value);}}}
  className="whitespace-pre-wrap text-[14px] leading-6 outline-none"/></div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const main = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:700,height:450,show:true});
 const js=c=>win.webContents.executeJavaScript(c,true);
 const key=async(keyCode,modifiers=[])=>{
  win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(100);
 };
 const type=async text=>{await win.webContents.insertText(text);await delay(100);};
 // sendInputEvent does not dispatch macOS menu accelerators. Invoke the same
 // native Select All command as the Edit menu, then release the shortcut.
 const selectAll=async()=>{win.webContents.selectAll();await key('a',['meta']);};
 const reset=async value=>{await js('qa.setDraft({value:'+JSON.stringify(value)+',cursor:'+value.length+'})');await delay(100);};
 const paste=async text=>{
  await js('(()=>{const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(text)+');document.querySelector("[role=textbox]").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
  await delay(100);
 };
 try {
  await win.loadURL(process.env.QA_URL);
  for(let i=0;i<100&&!await js('!!window.qa?.ref.current');i++)await delay(50);
  await js('document.querySelector("[role=textbox]").focus()');
  await type('第一行 hello');await key('Return');await type('第二行 world');
  const selection = () => js('({text:getSelection().toString(),collapsed:getSelection().isCollapsed,cursor:qa.draft.cursor,value:qa.draft.value})');
  await selectAll();
  const first = await selection();
  await selectAll();
  const second = await selection();
  console.log(JSON.stringify({first,second}));
  assert.equal(first.text, first.value, 'first Cmd+A must select the whole composer');
  assert.equal(second.text, second.value, 'repeated Cmd+A keeps the selection');
  await type('替换');
  assert.equal(await js('qa.draft.value'),'替换','typing replaces the selection');
  await selectAll();await key('Backspace');
  assert.equal(await js('qa.draft.value'),'','first select-all followed by delete clears the composer');

  await reset('one two three');
  await key('Left',['shift']);await key('Left',['shift']);
  assert.equal((await selection()).text,'ee','Shift+Arrow extends a backward selection');
  await js('qa.setLabels({refresh:"labels"})');await delay(100);
  assert.equal((await selection()).text,'ee','metadata rerender retains both selection endpoints');
  await key('Left',['shift']);
  assert.equal((await selection()).text,'ree','metadata rerender retains selection direction');
  await paste('X');
  assert.equal(await js('qa.draft.value'),'one two thX','paste replaces a partial selection');

  await reset('one two three');
  await js('(()=>{const e=document.querySelector("[role=textbox]");getSelection().setBaseAndExtent(e.firstChild,4,e.firstChild,7);e.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}))})()');
  await delay(100);
  assert.equal((await selection()).text,'two','mouse range survives state synchronization');
  await paste('new');assert.equal(await js('qa.draft.value'),'one new three');
  await selectAll();await paste('粘贴\n替换');
  assert.equal(await js('qa.draft.value'),'粘贴\n替换','paste replaces the entire selection');
  await selectAll();await key('Return',['shift']);
  assert.equal(await js('qa.draft.value'),'\n','Shift+Enter replaces selected text with a newline');

  await reset('See @src/main.ts and more\n');
  assert.equal(await js('!!document.querySelector("[data-segment-type=mention]")'),true);
  await selectAll();
  const chipSelection=await selection();assert.equal(chipSelection.collapsed,false);
  await js('qa.setLabels({refresh:"chips"})');await delay(100);
  assert.equal((await selection()).text,chipSelection.text,'chip rerender preserves selection');
  await paste('done');
  assert.equal(await js('qa.draft.value'),'done','selected chips use raw-text offsets when replaced');
  await selectAll();await js('qa.setDraft({...qa.draft,cursor:2})');await delay(100);
  assert.equal((await selection()).collapsed,true,'explicit external cursor movement still applies');
  await type('!');assert.equal(await js('qa.draft.value'),'do!ne');
  console.log('SELECTION_QA_OK');app.exit(0);
 } catch(error) {console.error(error);app.exit(1);}
});
`;
let server;
try {
  await writeFile(path.join(tmp, 'index.html'), '<html><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmp, 'harness.tsx'), harness);
  await writeFile(path.join(tmp, 'main.cjs'), main);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(tmp, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.aegis-design-qa/**'] } } });
  await server.listen();
  const env = { ...process.env, BUBBLE_HOME: path.join(tmp, 'bubble-home'), QA_URL: new URL(path.relative(root, tmp) + '/index.html', server.resolvedUrls.local[0]).href, QA_CAPTURE: path.join(root, 'output/playwright/composer-selection') };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/electron'), [path.join(tmp, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data));
    const timeout = setTimeout(() => { child.kill(); reject(Error('Composer selection test timed out')); }, 30000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timeout); try { assert.equal(code, 0); assert(output.includes('SELECTION_QA_OK')); resolve(); } catch(error) { reject(error); } });
  });
} finally {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
}

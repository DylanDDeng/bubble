// Isolated visual fixture: only synthetic messages; no Agent account or session access.
import {createServer} from 'vite';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(path.join(root,'.aegis-design-qa'),{recursive:true});
const dir=await mkdtemp(path.join(root,'.aegis-design-qa/child-lifecycle-'));
await writeFile(path.join(dir,'index.html'),'<html><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
await writeFile(path.join(dir,'fixture.tsx'),String.raw`
import React, {useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Tooltip} from '@base-ui-components/react/tooltip';
import '/src/ui/index.css';
import {ToolExecutionBatch} from '/src/ui/components/ToolExecutionBatch';
import {SubagentPanel} from '/src/ui/components/SubagentPanel';
import {useAppStore} from '/src/ui/store/useAppStore';
import {groupSubagentMessagesByParent} from '/src/ui/utils/workstream';
const start=Date.now()-25000;
const call=(id,name,input)=>({type:'assistant',uuid:id,createdAt:start,message:{content:[{type:'tool_use',id,name,input}]}});
const result=(id,error=false)=>({type:'user',uuid:id+'-result',message:{content:[{type:'tool_result',tool_use_id:id,content:error?'Subagent was running; supplementary message was not delivered.':'ok',is_error:error}]}});
function App(){
 const [status,setStatus]=useState('running');const [delivery,setDelivery]=useState('');
 const child={agentId:'a',anchorId:'spawn',nickname:'John',role:'explorer',task:'只读 review /Users/example/my-coding-agent 的 Issue #74。核查消息展示与持久化，区分证据和推断。',status,activity:'Read · ChatPane.tsx',startedAt:start,updatedAt:start+20000,pendingInputCount:delivery==='queued'?1:0,inputDelivery:delivery||undefined};
 const messages=[call('spawn','spawn_agent',{agent_type:'explorer',message:child.task}),{type:'assistant',uuid:'state',parentToolUseId:'spawn',bubbleSubagent:child,message:{content:[]}},call('send','send_input',{agent_id:'a',message:'Check persistence as well'}),result('send',true),call('wait-1','wait_agent',{agent_id:'a'}),result('wait-1'),call('wait-2','wait_agent',{agent_id:'a'}),{...call('read','Read',{path:'desktop/src/ui/components/ChatPane.tsx'}),parentToolUseId:'spawn'}, {...result('read'),parentToolUseId:'spawn'}];
 if(status!=='running'&&status!=='queued')messages.push(result('wait-2'));
 const grouped=groupSubagentMessagesByParent(messages);
 useEffect(()=>{useAppStore.setState({activeSessionId:'qa',sessions:{qa:{id:'qa',provider:'bubble',status:'running',messages,cwd:'/tmp/fixture'}}})},[status,delivery]);
 return <Tooltip.Provider><div style={{background:'var(--bg-primary)',color:'var(--text-primary)',height:'100vh',fontSize:13}}>
 <nav style={{padding:12,display:'flex',gap:16,borderBottom:'1px solid var(--border)'}}><b>Isolated subagent lifecycle fixture</b>{['running','queued','completed','failed','cancelled'].map(value=><button key={value} onClick={()=>setStatus(value)}>{value}</button>)}<button onClick={()=>setDelivery('queued')}>Queue message</button><button onClick={()=>setDelivery('applied')}>Deliver message</button></nav>
 <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',height:'calc(100vh - 46px)'}}>
 <main style={{padding:28,borderRight:'1px solid var(--border)'}}><p style={{marginBottom:24}}>核查 Issue #74 的描述是否符合源码实际。</p><ToolExecutionBatch messages={messages.filter(m=>m.type==='assistant'&&!m.parentToolUseId)} toolStatusMap={new Map([['spawn','pending'],['wait-2',status==='running'?'pending':'success']])} toolResultsMap={new Map()} isSessionRunning isLastBatch subagentMessagesByParent={grouped} defaultExpanded /></main>
 <aside style={{position:'relative'}}><SubagentPanel collapsed={false} sessionId="qa" subagentId="spawn"/></aside>
 </div></div></Tooltip.Provider>;
}
createRoot(document.getElementById('root')).render(<App/>);
`);
const server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
await server.listen();
console.log(`QA_URL=http://127.0.0.1:${server.httpServer.address().port}/${path.relative(root,dir)}/index.html`);
let closing=false;
async function close(){if(closing)return;closing=true;await server.close();await rm(dir,{recursive:true,force:true});process.exit(0)}
process.on('SIGTERM',close);process.on('SIGINT',close);

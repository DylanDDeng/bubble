const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-tool-stream-'));
app.setPath('userData', path.join(dir, 'profile'));
process.env.BUBBLE_HOME = path.join(dir, 'agent');
app.whenReady().then(() => {
  const { toolInputPreview } = require('../../dist-electron/electron/libs/provider/tool-input-preview');
  assert.deepEqual(toolInputPreview('{"path":"/tmp/上海\\u0020x.html","content":"unfinished'), {path:'/tmp/上海 x.html'});
  assert.deepEqual(toolInputPreview('{"content":"\\\"path\\\":\\\"fake\\\"","nested":{"path":"wrong"},"path":"real"'), {path:'real'});
  assert.deepEqual(toolInputPreview('{"path":"unfinished'), {});
  assert.deepEqual(toolInputPreview('{"content":"' + 'x'.repeat(100000)), {});
  const store = require('../../dist-electron/electron/libs/session-store');
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter');
  store.initialize();
  const stored = store.createSession({title:'Tool streaming fixture',provider:'bubble',cwd:dir});
  const adapter = new BubbleSdkAdapter(), messages = [];
  adapter.events.on('event', event => {
    if (event.message) { messages.push(event.message); store.addMessage(stored.id, event.message); }
  });
  const session = {threadId:stored.id, currentAssistant:null, status:'running',
    subagentStreams:new Map(),subagentStartedAt:new Map(),toolNames:new Map(),heldSpawnResults:new Map(),
    emittedToolCallIds:new Set(),emittedToolResultIds:new Set(),usage:{},totalCostUsd:0,durationStartMs:Date.now()};
  const event = value => adapter.handleBubbleEvent(session, value);
  event({type:'reasoning_delta',content:'A'.repeat(93575)});
  event({type:'text_delta',content:"Now I'll write the full scene file."});
  event({type:'tool_call_start',id:'write',name:'write'});
  const preview = messages.at(-1), createdAt = preview.createdAt;
  assert.equal(preview.message.content[0].name,'Write');
  assert.equal(preview.message.content[0].input.__aegisToolCallStreaming,true);
  assert.equal(messages.at(-2).phase,'commentary');
  const firstCount = messages.length;
  event({type:'tool_call_start',id:'write',name:'write'});
  assert.equal(messages.length,firstCount,'duplicate start does not create a new row');
  let args = '{"path":"/tmp/scene.html","content":"';
  event({type:'tool_call_delta',id:'write',name:'write',arguments:args});
  assert.equal(messages.at(-1).message.content[0].input.path,'/tmp/scene.html');
  for (let i=0;i<12000;i++) {
    args += 'html data ';
    event({type:'tool_call_delta',id:'write',name:'write',arguments:args});
  }
  assert.equal(messages.length,firstCount+1,'large arguments produce no per-token history or IPC copies');
  assert.equal(JSON.stringify(messages.at(-1)).length<700,true);
  const full = {path:'/tmp/scene.html',content:'<html>\n'+'content\n'.repeat(1565)+'</html>'};
  event({type:'tool_call_end',id:'write',name:'write',arguments:JSON.stringify(full)});
  const canonical = messages.at(-1);
  assert.equal(canonical.uuid,preview.uuid);
  assert.equal(canonical.createdAt,createdAt);
  assert.deepEqual(canonical.message.content[0].input,full);
  const count = messages.length;
  event({type:'tool_start',id:'write',name:'write',args:full});
  event({type:'tool_call_delta',id:'write',name:'write',arguments:'{"path":"wrong"}'});
  assert.equal(messages.length,count,'canonical execution is not duplicated or overwritten by late deltas');
  event({type:'tool_end',id:'write',name:'write',result:{content:'Wrote scene.html'}});
  // Interrupted generation remains unfinished, never a successful write.
  event({type:'tool_call_start',id:'interrupted',name:'write'});
  event({type:'tool_call_delta',id:'interrupted',name:'write',arguments:'{"path":"/tmp/incomplete.html","content":"'});
  adapter.finishTurn(session,new Error('fixture transport interruption'));
  assert.equal(session.streamingToolCalls.size,0);
  assert.equal(messages.some(m=>m.message?.content?.some(b=>b.type==='tool_result'&&b.tool_use_id==='interrupted')),false);
  store.close();store.initialize();
  const history=store.getSessionHistory(stored.id);
  const saved=history.filter(m=>m.uuid===preview.uuid);
  assert.equal(saved.length,1,'history reopens with one updated tool');
  assert.equal(saved[0].createdAt,createdAt);
  assert.deepEqual(saved[0].message.content[0].input,full);
  assert(history.some(m=>m.message?.content?.some(b=>b.thinking?.length===93575)),'thinking is retained without a 20k storage limit');
  // Nested calls have the same lifecycle and retain their parent identity.
  const childEvent = child => adapter.handleSubagentUpdate(session,{type:'subagent_update',parentToolCallId:'spawn',runId:'run',subAgentId:'child',agentName:'worker',status:'running',childEvent:child});
  childEvent({type:'tool_call_start',id:'child-write',name:'write'});
  childEvent({type:'tool_call_delta',id:'child-write',name:'write',arguments:'{"path":"/tmp/child.html",'});
  childEvent({type:'tool_call_end',id:'child-write',name:'write',arguments:JSON.stringify(full)});
  const childCalls=messages.filter(m=>m.uuid===`bubble-sub-tool-use:${stored.id}:child-write`);
  assert.equal(childCalls.length,3);
  assert(childCalls.every(m=>m.parentToolUseId==='spawn'));
  assert.deepEqual(childCalls.at(-1).message.content[0].input,full);
  childEvent({type:'tool_start',id:'child-write',name:'write',args:full});
  assert.equal(messages.filter(m=>m.uuid===childCalls[0].uuid).length,3);
  store.close();
  console.log('PASS: 12,000 argument deltas; immediate activity, bounded previews, canonical replacement, SQLite reopen, interruption and nested attribution');
}).then(()=>{fs.rmSync(dir,{recursive:true,force:true});app.exit(0)},error=>{console.error(error);app.exit(1)});

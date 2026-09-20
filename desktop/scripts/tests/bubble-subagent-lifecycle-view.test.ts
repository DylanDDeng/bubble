import { buildActivityUnits } from '../../src/ui/utils/activity-units';
import assert from 'node:assert/strict';
import type { StreamMessage, BubbleSubagentState } from '../../src/shared/types';
import { createBatchWorkstreamModel, groupSubagentMessagesByParent, type ToolResultBlock } from '../../src/ui/utils/workstream';
import { getMessageContentBlocks, normalizeToolUseBlock, normalizeToolResultBlock } from '../../src/ui/utils/message-content';
import type { ToolStatus } from '../../src/ui/types';
import { deriveSubagentSummaries } from '../../src/ui/utils/subagent-registry';
import { childOperations, shortChildTask } from '../../src/ui/utils/bubble-subagent-view';

const call = (id: string, name: string, input: object): StreamMessage => ({ type: 'assistant', uuid: id, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, error = false): StreamMessage => ({ type: 'user', uuid: `${id}-result`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'Could not deliver' : 'ok', is_error: error }] } });
const state: BubbleSubagentState = { agentId: 'a', anchorId: 'spawn', nickname: 'John', role: 'explorer', task: '只读 review /Users/example/my-project 的 Issue #74。完整调查指令', status: 'running', activity: 'Read · ChatPane.tsx', startedAt: 1000, updatedAt: 2000, pendingInputCount: 0 };
const stateMessage = (value = state): StreamMessage => ({ type: 'assistant', uuid: `state-${value.agentId}`, parentToolUseId: value.anchorId, bubbleSubagent: value, message: { content: [] } });
const messages = [call('spawn', 'spawn_agent', { agent_type: 'explorer', message: state.task }), stateMessage(), call('send', 'send_input', { agent_id: 'a', message: 'extra' }), result('send', true), call('wait1', 'wait_agent', { agent_id: 'a' }), result('wait1'), call('wait2', 'wait_agent', { agent_ids: ['a'] })];
function model(input: StreamMessage[], running = true) {
  const grouped = groupSubagentMessagesByParent(input);
  const toolStatusMap = new Map<string, ToolStatus>();
  const toolResultsMap = new Map<string, ToolResultBlock>();
  for (const message of input) for (const block of getMessageContentBlocks(message)) {
    const tool = normalizeToolUseBlock(block);
    if (tool) toolStatusMap.set(tool.id, 'pending');
    const result = normalizeToolResultBlock(block);
    if (result) {
      toolStatusMap.set(result.tool_use_id, result.is_error ? 'error' : 'success');
      toolResultsMap.set(result.tool_use_id, result as ToolResultBlock);
    }
  }
  return createBatchWorkstreamModel({ messages: input.filter((m): m is StreamMessage & {type:'assistant'} => m.type === 'assistant' && !m.parentToolUseId), toolStatusMap, toolResultsMap, isSessionRunning: running, subagentMessagesByParent: grouped });
}
const view = model(messages);
assert.equal(view.entries.length, 4, 'child, failed message, completed wait and current wait stay chronological');
assert.equal(view.entries[3].id, 'wait2', 'resolved waits do not duplicate the active wait');
assert(view.entries[3].type === 'tool');
assert.deepEqual(view.entries[3].subagentWait, [{anchorId:'spawn',name:'John'}]);
assert.equal(view.entries[0].type, 'task');
assert.equal(view.entries[0].status, 'pending', 'delivery error does not fail child');
assert.equal(view.entries[0].status, 'pending', 'coordination failure remains separate from task status');
const summary = deriveSubagentSummaries(messages)[0];
assert.equal(summary.persona.persona, 'John');
assert.equal(summary.runtime?.agentId, 'a');
assert(!shortChildTask(state.task).includes('/Users/'));
assert.equal(summary.operations?.filter(op => op.failed).length, 1);
assert(summary.operations?.some(op => op.pending && op.label.includes('Main agent')));
const restored = JSON.parse(JSON.stringify(messages));
assert.deepEqual(deriveSubagentSummaries(restored), deriveSubagentSummaries(messages), 'reload preserves identity, state and coordination');
const failedChild = messages.map(m => m.bubbleSubagent ? stateMessage({...state,status:'failed',updatedAt:3000}) : m);
assert.equal(model(failedChild).entries[0].status, 'error', 'real child failure overrides spawn success');
const stoppedChild = messages.map(m => m.bubbleSubagent ? stateMessage({...state,status:'cancelled',updatedAt:3000}) : m);
assert.equal(model(stoppedChild).entries[0].status, 'interrupted');
const unknown = [...messages, call('unknown', 'send_input', {agent_id:'missing',message:'x'})];
assert.equal(model(unknown).entries.length, 5, 'unlinked errors/calls are never silently hidden');
assert(!model(unknown).entries[4].summary.includes('agent_id'));
const parallel = [...messages, call('spawn-b','spawn_agent',{message:'Another task'}),stateMessage({...state,agentId:'b',anchorId:'spawn-b',nickname:'Jane'}),call('wait-all','wait_agent',{})];
assert.equal(model(parallel).entries.filter(entry=>entry.type==='task').length, 2);
const allWait = model(parallel).entries.find(entry=>entry.id==='wait-all');
assert(allWait?.type === 'tool');
assert.deepEqual(allWait.subagentWait?.map(target=>target.name), ['John','Jane']);
for(const lane of groupSubagentMessagesByParent(parallel).values()) assert(childOperations(lane).some(op=>op.id==='wait-all'));

const created = model([call('spawn','spawn_agent',{message:state.task}),result('spawn'),stateMessage()]);
assert.equal(created.entries[0].status,'pending','successful creation is not child completion');
const timeout: StreamMessage = {type:'user',uuid:'timeout',message:{content:[{type:'tool_result',tool_use_id:'wait2',content:'Timed out; child still running'}]}};
const afterTimeout = model([...messages,timeout]);
assert.equal(afterTimeout.entries.length,4,'timed-out wait remains inspectable in history');
assert(!afterTimeout.entries.some(e=>e.type==='tool' && e.subagentWait),'no live wait after timeout');
assert.equal(afterTimeout.entries[0].status,'pending','wait timeout never fails or completes the child');
const completing = messages.map(m=>m.bubbleSubagent?stateMessage({...state,status:'completed',updatedAt:3000}):m);
assert.equal(model(completing).entries[3].summary,'Collecting results from','pending wait after terminal event does not claim child still works');
assert.equal(model([...completing,result('wait2')],false).entries.filter(e=>e.type==='task').length,1,'settled turn retains one child history row');
assert(!model(messages,false).entries.some(entry=>entry.type==='tool' && entry.subagentWait),'stopped parent never shows a live wait');
assert.deepEqual(model(restored),view,'restored history has the same wait targets and lifecycle');
console.log('PASS: independent child lifecycle, named current wait, timeouts, parallel targets, stop and history reload');

// The transcript has one status row per child; raw coordination stays in its details.

const units = (input: StreamMessage[], running = true) => buildActivityUnits(model(input, running).entries);
assert.deepEqual(units(messages).map(unit => unit.kind), ['tasks', 'standalone'], 'only failed send remains standalone; both waits are nested');
const implicitMessages = [call('spawn','spawn_agent',{message:state.task}), stateMessage(), call('implicit','wait_agent',{})];
const implicitCompleted = [...implicitMessages.map(m => m.bubbleSubagent ? stateMessage({...state,status:'completed',updatedAt:3000}) : m), result('implicit')];
assert.deepEqual(units(implicitMessages).map(unit=>unit.kind), ['tasks']);
assert.deepEqual(units(JSON.parse(JSON.stringify(implicitCompleted)),false).map(unit=>unit.kind), ['tasks'], 'no-ID wait association survives terminal snapshots and reload');
assert.equal(model(implicitCompleted,false).entries[0].type,'task');
const implicitTask=model(implicitCompleted,false).entries[0];
assert(implicitTask.type==='task' && implicitTask.subagent?.operations?.some(op=>op.id==='implicit'), 'implicit wait remains inspectable');
const laterSpawn=[...implicitMessages,call('spawn-b','spawn_agent',{message:'Later task'}),stateMessage({...state,agentId:'b',anchorId:'spawn-b',nickname:'Jane'})];
assert(!childOperations(groupSubagentMessagesByParent(laterSpawn).get('spawn-b')!).some(op=>op.id==='implicit'), 'later spawns are not retroactive targets');
const mixed=[...implicitMessages,call('mixed','wait_agent',{agent_ids:['a','unknown']}),result('mixed',true)];
assert(units(mixed).some(unit=>unit.kind==='standalone' && unit.id==='mixed'),'unknown part of a mixed wait remains visible');
const unknownWait=[...implicitMessages,call('unknown-wait','wait_agent',{agent_id:'missing'}),result('unknown-wait',true)];
assert(units(unknownWait).some(unit=>unit.kind==='group' && unit.entries.some(entry=>entry.id==='unknown-wait')),'fully unknown wait errors remain inspectable');
const laterTurn = model(messages).entries.filter(entry=>entry.type!=='task');
assert(buildActivityUnits(laterTurn).some(unit=>unit.kind==='standalone' && unit.id==='wait2'),'cross-turn wait stays visible when its child row is outside this turn');
const partial=[...parallel,result('wait-all')];
for(const lane of groupSubagentMessagesByParent(partial).values()) {
  assert.equal(childOperations(lane).find(op=>op.id==='wait-all')?.label,'Wait returned','a returned multi-target wait is not a per-child completion');
}
assert(childOperations(groupSubagentMessagesByParent([...messages,timeout]).get('spawn')!).find(op=>op.id==='wait2')?.label.includes('timed out'));
console.log('PASS: one-row wait projection, implicit targets, reload, unknown/cross-turn targets and partial results');
const padded=[call('spawn','spawn_agent',{message:state.task}),stateMessage(),call('padded','wait_agent',{agent_ids:[' a ','a']})];
assert.deepEqual(units(padded).map(unit=>unit.kind),['tasks'],'ID normalization matches runtime trimming and deduplication');

// Full dispatch text must survive independently of compact descriptions/runtime arrival.
for (const field of ['prompt', 'message', 'task']) {
  const fullTask = 'Read-only investigation instruction. '.repeat(30);
  const pending = deriveSubagentSummaries([call('dispatch', 'spawn_agent', { [field]: fullTask })])[0];
  assert.equal(pending.task, fullTask);
  assert((pending.description?.length ?? 0) <= 200);
}
assert.equal(deriveSubagentSummaries([call('spawn', 'spawn_agent', {}), stateMessage()])[0].task, state.task);

import assert from 'node:assert/strict';
import type { StreamMessage, BubbleSubagentState } from '../../src/shared/types';
import { createBatchWorkstreamModel, groupSubagentMessagesByParent } from '../../src/ui/utils/workstream';
import { deriveSubagentSummaries } from '../../src/ui/utils/subagent-registry';
import { childOperations, shortChildTask } from '../../src/ui/utils/bubble-subagent-view';

const call = (id: string, name: string, input: object): StreamMessage => ({ type: 'assistant', uuid: id, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, error = false): StreamMessage => ({ type: 'user', uuid: `${id}-result`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'Could not deliver' : 'ok', is_error: error }] } });
const state: BubbleSubagentState = { agentId: 'a', anchorId: 'spawn', nickname: 'John', role: 'explorer', task: '只读 review /Users/example/my-project 的 Issue #74。完整调查指令', status: 'running', activity: 'Read · ChatPane.tsx', startedAt: 1000, updatedAt: 2000, pendingInputCount: 0 };
const stateMessage = (value = state): StreamMessage => ({ type: 'assistant', uuid: `state-${value.agentId}`, parentToolUseId: value.anchorId, bubbleSubagent: value, message: { content: [] } });
const messages = [call('spawn', 'spawn_agent', { agent_type: 'explorer', message: state.task }), stateMessage(), call('send', 'send_input', { agent_id: 'a', message: 'extra' }), result('send', true), call('wait1', 'wait_agent', { agent_id: 'a' }), result('wait1'), call('wait2', 'wait_agent', { agent_ids: ['a'] })];
function model(input: StreamMessage[]) {
  const grouped = groupSubagentMessagesByParent(input);
  return createBatchWorkstreamModel({ messages: input.filter((m): m is StreamMessage & {type:'assistant'} => m.type === 'assistant' && !m.parentToolUseId), toolStatusMap: new Map(), toolResultsMap: new Map(), isSessionRunning: true, subagentMessagesByParent: grouped });
}
const view = model(messages);
assert.equal(view.entries.length, 1, 'coordination belongs to one child card');
assert.equal(view.entries[0].type, 'task');
assert.equal(view.entries[0].status, 'pending', 'delivery error does not fail child');
assert(!view.summary.includes('failed'), 'coordination failure is not aggregated as task failure');
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
assert.equal(model(unknown).entries.length, 2, 'unlinked errors/calls are never silently hidden');
assert(!model(unknown).entries[1].summary.includes('agent_id'));
const parallel = [...messages, call('spawn-b','spawn_agent',{message:'Another task'}),stateMessage({...state,agentId:'b',anchorId:'spawn-b',nickname:'Jane'}),call('wait-all','wait_agent',{})];
assert.equal(model(parallel).entries.length, 2);
for(const lane of groupSubagentMessagesByParent(parallel).values()) assert(childOperations(lane).some(op=>op.id==='wait-all'));
console.log('PASS: stable child identity, one card, wait coalescing, separate delivery errors, parallel children and history reload');

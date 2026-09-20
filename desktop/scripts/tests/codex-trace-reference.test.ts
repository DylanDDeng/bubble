// Optional local differential check against the installed reference, never a runtime dependency.
// Extract only reviewed pure state functions; do not import/execute the application bundle.
import asar from '@electron/asar';
import ts from 'typescript';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { activityDetailGroups, buildActivityUnits, getActivityHeader, hasActivityDetail } from '../../src/ui/utils/activity-units';
import type { WorkstreamEntry } from '../../src/ui/utils/workstream';

const archive = process.env.CODEX_REFERENCE_ASAR || '/Applications/Codex.app/Contents/Resources/app.asar';
const asset = 'webview/assets/agent-activity-units-48dc779bfb79.js';
const source = asar.extractFile(archive, asset).toString('utf8');
function extractFunctions(source: string, names: string[]): string {
  const parsed = ts.createSourceFile('reference.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''))
    .map(node => node.getText(parsed));
  assert.equal(functions.length, names.length, 'reference version changed; re-audit the native state functions');
  return functions.join('\n');
}
const blocks = asar.extractFile(archive, 'webview/assets/conversation-blocks-3f5612e1f0d0.js').toString('utf8');
const itemSource = asar.extractFile(archive, 'webview/assets/agent-activity-item-3801f7067f55.js').toString('utf8');
// This oracle covers ordinary filesystem operations, not skills, visualization
// commands or rich MCP apps. Those imported predicates are explicitly false
// only for this dataset. gn is exercised only on reasoning/assistant messages.
const context = { S: () => false, y: () => false, Yf: () => false, G: { default: (items: unknown[]) => items.at(-1) },
  le: () => false, p: () => false, $: (item: unknown, grouping: string) => ({ item, grouping }) };
const native = vm.runInNewContext(`${extractFunctions(source, ['Je', 'Ye', 'Z', 'N', 'H', 'W', 'Fe', 'qe', 'Q', 'Ge'])}
  ${extractFunctions(blocks, ['yT'])}
  ${extractFunctions(itemSource, ['gn'])}
  ({ header: Je, exploration: W, groups: qe, details: Ge, detailVisible: yT, normalize: gn })`, context, { timeout: 1000 });
const variants = ['file_read', 'pattern_search', 'command_execution', 'mcp_tool_call', 'file_change'] as const;
const statuses = ['pending', 'success', 'error', 'interrupted'] as const;
let checked = 0;
for (const first of variants) for (const second of variants) for (const a of statuses) for (const b of statuses) {
  const entries: WorkstreamEntry[] = [{ id: 'first', kind: first, status: a }, { id: 'second', kind: second, status: b }]
    .map(entry => ({ ...entry, type: 'tool', toolName: entry.kind, summary: entry.kind,
      block: { type: 'tool_use', id: entry.id, name: entry.kind, input: {} } }));
  const items = entries.map(entry => {
    assert(entry.type === 'tool');
    return { item: entry.kind === 'file_change'
      ? { type: 'patch', id: entry.id, changes: { 'sample.ts': {} }, success: entry.status === 'pending' ? null : entry.status === 'success' }
      : entry.kind === 'mcp_tool_call'
        ? { type: 'mcp-tool-call', id: entry.id, completed: entry.status !== 'pending' }
        : { type: 'exec', id: entry.id, executionStatus: entry.status,
          parsedCmd: { type: entry.kind === 'file_read' ? 'read' : entry.kind === 'pattern_search' ? 'search' : 'unknown',
            isFinished: entry.status !== 'pending' } } };
  });
  for (const live of [true, false]) {
    for (const reasoningPosition of [-1, 0, 1, 2]) {
      const bubbleEntries = [...entries];
      const agentItems = items.map(({item}) => item);
      if (reasoningPosition >= 0) {
        bubbleEntries.splice(reasoningPosition, 0, { id: 'reasoning', type: 'thinking', state: 'active', summary: '**Checking**' });
        agentItems.splice(reasoningPosition, 0, { type: 'reasoning', completed: false } as typeof agentItems[number]);
      }
      const { isExploring } = native.exploration({ agentItems, isTurnInProgress: live, isAnyNonAgentItemInProgress: false });
      const expected = native.header({ unit: { items }, isLatestVisibleUnit: true, isTurnInProgress: live,
        isActivitySliceClosed: !live, isExploring });
      const actual = getActivityHeader(bubbleEntries, live);
      assert.equal(actual.kind, expected.kind, JSON.stringify({ entries, live, reasoningPosition }));
      if (actual.kind === 'active') assert.equal(actual.entry.id, expected.item.item.id);
      checked++;
    }
  }
  for (let i = 0; i < entries.length; i++) {
    assert.equal(hasActivityDetail(entries[i]), native.detailVisible(items[i], false));
  }
}
assert.equal(native.normalize({type:'reasoning'}), null);
assert.equal(buildActivityUnits([{id:'only-reasoning',type:'thinking',summary:'Thinking',state:'active'}]).length, 0);
const reads: WorkstreamEntry[] = ['a','b'].map(id=>({id,type:'tool',kind:'file_read',toolName:'Read',status:'success',summary:'Read '+id,block:{type:'tool_use',id,name:'Read',input:{file_path:id}}}));
const nativeReads = reads.map(entry=>({grouping:'groupable',item:{id:entry.id,type:'exec',parsedCmd:{type:'read',isFinished:true}}}));
assert.equal(activityDetailGroups(reads).length, native.details(nativeReads, ()=>'Read').length);
for (const position of [0,1,2]) {
  const bubbleEntries = [...reads];
  bubbleEntries.splice(position,0,{id:'note',type:'note',summary:'Checking next'});
  const nativeItems = [...nativeReads];
  nativeItems.splice(position,0,native.normalize({id:'note',type:'assistant-message'}));
  const expected = native.groups(nativeItems.map((activityItem,sourceIndex)=>({activityItem,sourceIndex,startsGroup:false})));
  assert.deepEqual(buildActivityUnits(bubbleEntries).map(unit=>unit.kind),Array.from(expected,(unit:{kind:string})=>unit.kind));
}
console.log(`PASS: ${checked} activity-header cases plus reasoning filtering, chronological boundaries, exploration details and pending-detail visibility agree with native Codex; reference SHA256 ${createHash('sha256').update(source).digest('hex')}`);

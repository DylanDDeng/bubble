import assert from 'node:assert/strict';
import { activityDetailGroups, buildActivityStages, buildActivityUnits, getActivityHeader, hasActivityDetail, reasoningHeading } from '../../src/ui/utils/activity-units';
import type { WorkstreamEntry } from '../../src/ui/utils/workstream';
const tool = (id: string, kind: 'mcp_tool_call' | 'file_read' | 'command_execution' | 'file_change' = 'mcp_tool_call', status: 'pending' | 'success' | 'error' = 'success'): WorkstreamEntry => ({
  id, type: 'tool', toolName: 'mcp__docs__read', kind, status, summary: 'Read docs',
  block: { type: 'tool_use', id, name: 'mcp__docs__read', input: { page: id } },
});
const think: WorkstreamEntry = { id: 'thought', type: 'thinking', summary: 'Inspect', detail: '**Checking the runtime**\nInspect event ordering.', state: 'active' };
assert.deepEqual(getActivityHeader([tool('done')], true), { kind: 'thinking', key: 'thinking', label: 'Thinking' });
assert.equal(getActivityHeader([tool('done'), think], true).kind, 'thinking');
assert.equal(reasoningHeading([think]), 'Checking the runtime');
assert.equal(reasoningHeading([{ ...think, detail: '**Streaming an unfinished heading' }]), undefined);
assert.equal(getActivityHeader([tool('running', 'mcp_tool_call', 'pending'), tool('failed', 'mcp_tool_call', 'error')], true).key, 'active:running', 'historical failure does not conceal a live operation');
assert.equal(getActivityHeader([tool('running', 'mcp_tool_call', 'pending')], false).kind, 'summary', 'closed slices never take over current status');
assert.equal(getActivityHeader([think], false).kind, 'summary');
assert.deepEqual(getActivityHeader([tool('done')], true, 'Checking the runtime'), {
  kind: 'thinking', key: 'thinking', label: 'Checking the runtime',
}, 'a narration boundary does not lose the turn-wide reasoning heading');
assert.equal(getActivityHeader([tool('pending', 'mcp_tool_call', 'pending')], true, 'Checking the runtime').kind,
  'active', 'turn-wide reasoning never conceals a pending operation');
assert.equal(buildActivityUnits([tool('read', 'file_read'), think, tool('shell', 'command_execution')]).length, 1, 'reasoning does not split a tool activity group');
assert.deepEqual(buildActivityUnits([think]), [], 'reasoning feeds the turn fallback, not an activity row');
assert.equal(buildActivityUnits([think, tool('read', 'file_read')])[0].id, 'activity:read', 'reasoning cannot change an activity group identity');
assert.equal(hasActivityDetail(tool('read', 'file_read', 'pending')), false, 'unfinished reads have no empty detail row');
assert.equal(hasActivityDetail(tool('read', 'file_read', 'error')), true, 'failed reads remain inspectable');
const units = buildActivityUnits([tool('a'), { id: 'n', type: 'note', summary: 'I will verify it' }, tool('b'), { id: 'e', type: 'error', summary: 'Connection lost' }]);
assert.deepEqual(units.map(u => u.kind), ['group', 'standalone', 'group', 'standalone']);
assert.equal(buildActivityUnits([tool('a'), { id: 'p', type: 'approval', state: 'waiting', summary: 'Approve?' }]).at(-1)?.kind, 'standalone');
assert.equal(activityDetailGroups([tool('a', 'command_execution'), tool('b', 'command_execution')]).length, 2, 'commands never merge merely because they share a stage kind');
assert.equal(activityDetailGroups([tool('a', 'file_change'), tool('b', 'file_change')]).length, 2);
assert.equal(activityDetailGroups([tool('a', 'file_read'), think, tool('b', 'file_read')]).length, 2, 'native activity details retain individual exploration operations');
assert.deepEqual(buildActivityStages([tool('a', 'file_read'), tool('b', 'file_read')]).map(stage => stage.title), ['Read docs', 'Read docs']);
assert.equal(activityDetailGroups([tool('a'), tool('b')]).length, 1, 'identical successful MCP labels coalesce');
assert.equal(activityDetailGroups([tool('a'), { ...tool('b'), toolName: 'mcp__other__read' } as WorkstreamEntry]).length, 2, 'server identity is significant');
assert.equal(activityDetailGroups([tool('a'), tool('b', 'mcp_tool_call', 'error')]).length, 2);
assert.equal(activityDetailGroups([tool('a'), tool('b', 'mcp_tool_call', 'pending')]).length, 2);
assert.equal(activityDetailGroups([tool('a'), { ...tool('b'), summary: 'Another target' }]).length, 2);
const task = (id: string, sourceMessageUuid?: string): WorkstreamEntry => ({ id, type: 'task', toolName: 'spawn_agent', kind: 'subagent', summary: 'Review', status: 'pending', block: { type: 'tool_use', id, name: 'spawn_agent', input: {} }, sourceMessageUuid });
assert.equal(buildActivityUnits([task('a', 'fanout'), task('b', 'fanout')]).length, 1);
assert.equal(buildActivityUnits([task('a', 'one'), task('b', 'two')]).length, 2, 'sequential agents are separate events');
console.log('PASS: Codex activity boundaries, liveness, reasoning summaries, command/edit identity and MCP aggregation');

assert.equal(buildActivityStages([tool('a'), tool('b')]).length, 1);
assert.equal(buildActivityStages([tool('a'), tool('b')])[0].title, 'Read docs · 2 calls');

assert.equal(getActivityHeader([tool('read', 'file_read')], true).kind, 'active', 'exploration remains active between completed reads');
assert.equal(getActivityHeader([tool('read', 'file_read'), think], true).kind, 'active', 'native exploration includes trailing reasoning until a non-exploration event arrives');

// Exercise the real adapter vocabulary, not only hand-constructed render fixtures.
import { classifyToolUse, deriveReadableToolDisplay, formatReadableToolSummary } from '../../src/ui/utils/tool-summary';
import { extractTraceEntries } from '../../src/ui/utils/workstream';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import type { StreamMessage } from '../../src/shared/types';
assert.equal(classifyToolUse('Bash', { command: 'ls -la src' }), 'pattern_search');
assert.equal(classifyToolUse('Bash', { cmd: 'rg --files src' }), 'pattern_search');
assert.equal(classifyToolUse('Bash', { command: 'npm test' }), 'command_execution');
// Command rows show the model's own description, else the command as written.
const bashTitle = (command: string, description?: string) =>
  formatReadableToolSummary(deriveReadableToolDisplay('Bash', { command, description }, 'success'));
assert.equal(
  bashTitle("cd /tmp && python3 -m http.server 8765 &\ncat > shot.html <<'EOF'\n<p>x</p>\nEOF", '最终实跑验证并检查眼睛渲染'),
  '最终实跑验证并检查眼睛渲染',
  'the model-written description is the title, whatever the command looks like',
);
assert.equal(bashTitle('head -n 5 a.csv'), 'Ran head -n 5 a.csv', 'without a description the command is never reinterpreted');
assert.equal(formatReadableToolSummary(deriveReadableToolDisplay('Bash', { command: 'rg --files src' }, 'pending')), 'Running rg --files src');
assert.equal(
  bashTitle('cd /tmp && python3 -m http.server 8765 >/tmp/http.log 2>&1 &\nSRV=$!\nnode shot.mjs\nkill $SRV'),
  'Ran python3 -m http.server 8765 >/tmp/http.log 2>&1 +2 more',
  'a leading cd / assignment never becomes the whole title, and the rest is counted',
);
assert.equal(bashTitle('cd /Users/me/app && ls -la'), 'Ran ls -la', 'cd prefix is skipped for the lead command');
assert.equal(bashTitle('cd /tmp'), 'Ran cd /tmp', 'a lone setup command still titles itself');
assert.equal(bashTitle('npm run build && npm test'), 'Ran npm run build +1 more');
assert.equal(bashTitle("grep -rn 'a|b;c' src | head -5"), "Ran grep -rn 'a|b;c' src | head -5", 'quoted separators and pipe stages are not extra work');
assert.equal(bashTitle("python3 - <<'EOF'\nimport os; print(1)\nEOF"), "Ran python3 - <<'EOF' import os; print(1)", 'heredoc bodies stay with their statement');
assert.equal(bashTitle('export CI=1\n# build; then test\nfor f in a b; do echo $f; done'), 'Ran for f in a b +1 more');
assert.equal(bashTitle('grep -c foo <<< hello\nnpm test'), 'Ran grep -c foo <<< hello +1 more', 'a here-string has no body to swallow');
assert.equal(bashTitle('node - <<\\EOF\na; b && c\nEOF\nnpm test'), 'Ran node - <<\\EOF a; b && c +1 more', 'escaped heredoc delimiters are recognized');
assert.equal(bashTitle("python3 - <<'EOF' | tee out.log\nprint(1)\nEOF"), "Ran python3 - <<'EOF' | tee out.log print(1)", 'a piped heredoc keeps its body preview');
const redosStart = performance.now();
bashTitle(`x=${'a='.repeat(40)}a b c`);
assert.ok(performance.now() - redosStart < 100, 'assignment detection must not backtrack exponentially');
// Exploration is a claim that the command only reads; anything else is a command.
const bashKind = (command: string) => classifyToolUse('Bash', { command });
assert.equal(bashKind('cd src && ls -la'), 'pattern_search', 'setup statements do not change what a command does');
assert.equal(bashKind('cat a.ts 2>&1 | head -20'), 'file_read', 'descriptor redirects and filters still only read');
assert.equal(bashKind('cat a.ts > /dev/null'), 'file_read');
assert.equal(bashKind('rg foo src | sort | uniq -c'), 'pattern_search');
assert.equal(bashKind("cat > voxel.html <<'EOF'\n<div>a</div>\nEOF"), 'command_execution', 'writing a file is not exploration');
assert.equal(bashKind("cat <<'EOF'\nhello\nEOF"), 'command_execution', 'a heredoc is inline input, not a file read');
assert.equal(bashKind('grep -rn foo src > hits.txt'), 'command_execution');
assert.equal(bashKind('cat a.log | tee copy.log'), 'command_execution', 'a pipe into an unrecognized command is not exploration');
assert.equal(bashKind('cat a.ts && npm test'), 'command_execution', 'exploration never hides other work');
assert.equal(bashKind('grep -rn "a > b" src'), 'pattern_search', 'quoted > is not a redirect');
// Setup is shell state only: anything that runs a program is work.
assert.equal(bashKind('source scripts/setup.sh && cat package.json'), 'command_execution', 'a sourced script runs arbitrary work');
assert.equal(bashKind("trap 'make clean' EXIT; cat a.ts"), 'command_execution', 'a trap handler runs later');
assert.equal(bashKind('X=$(make) && cat a.ts'), 'command_execution', 'a command substitution runs a program');
assert.equal(bashKind('export PATH=/x:$PATH && ls'), 'pattern_search');
// Read-only programs stop being read-only with their writing/executing options.
assert.equal(bashKind('cd repo && find . -delete'), 'command_execution');
assert.equal(bashKind('find . -name "*.tmp" -exec rm {} \;'), 'command_execution');
assert.equal(bashKind('fd -e log -x rm'), 'command_execution');
assert.equal(bashKind('rg foo src | sort -o out.txt'), 'command_execution');
assert.equal(bashKind('cat a.txt | uniq - out.txt'), 'command_execution', 'a second uniq operand is an output file');
assert.equal(bashKind('find src -name "-delete"'), 'pattern_search', 'quoted text is a value, not an option');
assert.equal(bashKind('rg foo src | sort | uniq -c'), 'pattern_search');
// Heredocs end only on an exact delimiter line (`<<-` strips tabs, not spaces).
assert.equal(bashTitle('cat <<EOF\n EOF \nnpm test\nEOF'), 'Ran cat <<EOF EOF npm test', 'a padded delimiter is body text');
assert.equal(bashTitle('cat <<-EOF\n\tbody\n\tEOF\nnpm test'), 'Ran cat <<-EOF body +1 more', '<<- strips leading tabs');
assert.equal(classifyToolUse('mcp__docs__read', {}), 'mcp_tool_call');
const thoughtMessage: StreamMessage = { type: 'assistant', uuid: 'reasoning-source', message: { content: [{type:'thinking', thinking:'**Checking**\nInspect the files'}] } };
const before: StreamMessage = { type:'assistant', uuid:'older', message:{content:[{type:'text',text:'Older note'}]} };
assert.equal(extractTraceEntries([thoughtMessage])[0].id, extractTraceEntries([before, thoughtMessage])[1].id, 'reasoning identity is unaffected by earlier history');
const partial: StreamMessage = {...thoughtMessage, message:{content:[{type:'thinking',thinking:''}]}};
assert.equal(extractTraceEntries([partial],{partialThinking:'**Checking**'})[0].id, extractTraceEntries([thoughtMessage])[0].id, 'a streamed reasoning slot retains identity when committed');
const noAnswer: StreamMessage[] = [
 {type:'user_prompt',prompt:'Inspect'}, thoughtMessage,
 {type:'result',subtype:'success',duration_ms:1000,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}},
];
const noAnswerWork = deriveTranscriptTimelineItems(noAnswer).find(item=>item.type==='work');
assert(noAnswerWork?.type==='work');
assert.equal(noAnswerWork.canCollapse,false,'a result without a final answer does not conceal the trace');
console.log('PASS: real tool classifications, reasoning identity and final-answer collapse boundary');

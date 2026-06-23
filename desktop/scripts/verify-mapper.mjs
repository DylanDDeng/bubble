// Headless verification of the AgentEvent -> ServerEvent mapping (TurnMapper).
// Bundles the pure mapper and asserts the emitted ServerEvent sequence for a
// synthetic turn. No GUI / no real provider needed.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist-electron/_turn-mapper.test.mjs');

await build({
  entryPoints: [resolve(root, 'src/electron/turn-mapper.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
});

const { TurnMapper } = await import(pathToFileURL(out).href);

// Deterministic uuids: u1, u2, ...
let n = 0;
const uuid = () => `u${++n}`;
const events = [];
const emit = (e) => events.push(e);

const mapper = new TurnMapper('sess1', emit, uuid);
mapper.handle({ type: 'turn_start' });
mapper.handle({ type: 'text_delta', content: 'Hello' });
mapper.handle({ type: 'text_delta', content: ' world' });
mapper.handle({ type: 'tool_start', id: 't1', name: 'read', args: { path: 'a.txt' } });
mapper.handle({ type: 'tool_end', id: 't1', result: { content: 'file contents' } });
mapper.handle({ type: 'turn_end' });

const failures = [];
const check = (label, cond) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
};

console.log('TurnMapper synthetic turn:');
check('emitted 6 server events', events.length === 6);
check('all events are stream.message', events.every((e) => e.type === 'stream.message'));

const m = events.map((e) => e.payload.message);
check('1: text_delta "Hello"', m[0].type === 'stream_event' && m[0].event.delta?.text === 'Hello');
check('2: text_delta " world"', m[1].type === 'stream_event' && m[1].event.delta?.text === ' world');
check('3: content_block_stop', m[2].type === 'stream_event' && m[2].event.type === 'content_block_stop');
// Assert structural invariants (not exact uuid counter values, which are brittle).
check(
  '4: streaming assistant, blocks [text "Hello world", tool_use read]',
  m[3].type === 'assistant' &&
    m[3].streaming === true &&
    typeof m[3].uuid === 'string' &&
    m[3].message.content.length === 2 &&
    m[3].message.content[0].type === 'text' &&
    m[3].message.content[0].text === 'Hello world' &&
    m[3].message.content[1].type === 'tool_use' &&
    m[3].message.content[1].name === 'read',
);
check(
  '5: user tool_result, distinct uuid, correct tool_use_id + content',
  m[4].type === 'user' &&
    m[4].uuid !== m[3].uuid &&
    m[4].message.content[0].type === 'tool_result' &&
    m[4].message.content[0].tool_use_id === 't1' &&
    m[4].message.content[0].content === 'file contents',
);
check(
  '6: finalized assistant streaming:false, SAME uuid as streaming emit, same 2 blocks',
  m[5].type === 'assistant' &&
    m[5].uuid === m[3].uuid &&
    m[5].streaming === false &&
    m[5].message.content.length === 2,
);

// finish() trailing-flush case
{
  const ev2 = [];
  let k = 0;
  const mp = new TurnMapper('s2', (e) => ev2.push(e), () => `v${++k}`);
  mp.handle({ type: 'text_delta', content: 'partial' });
  mp.finish();
  check(
    'finish() flushes trailing text into a final assistant message',
    ev2.length === 2 &&
      ev2[1].payload.message.type === 'assistant' &&
      ev2[1].payload.message.streaming === false &&
      ev2[1].payload.message.message.content[0].text === 'partial',
  );
}

// todos_updated -> plan_update (stable uuid, status mapping)
{
  const ev3 = [];
  let j = 0;
  const mp = new TurnMapper('s3', (e) => ev3.push(e), () => `w${++j}`);
  mp.handle({ type: 'turn_start' });
  mp.handle({
    type: 'todos_updated',
    todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
      { content: 'C', status: 'pending' },
    ],
  });
  const pm = ev3[ev3.length - 1]?.payload.message;
  check(
    'todos_updated -> plan_update with mapped steps',
    pm?.type === 'plan_update' &&
      pm.steps.length === 3 &&
      pm.steps[0].step === 'A' &&
      pm.steps[0].status === 'completed' &&
      pm.steps[1].status === 'inProgress' &&
      pm.steps[2].status === 'pending',
  );
}

// turn_end with usage -> result message (final turn only)
{
  const ev4 = [];
  let q = 0;
  const mp = new TurnMapper('s4', (e) => ev4.push(e), () => `x${++q}`);
  mp.handle({ type: 'text_delta', content: 'done' });
  mp.handle({ type: 'turn_end', usage: { promptTokens: 100, completionTokens: 20 }, willContinue: false });
  const res = ev4.find((e) => e.payload.message.type === 'result');
  check(
    'turn_end(usage, final) -> result with input/output tokens',
    !!res && res.payload.message.usage.input_tokens === 100 && res.payload.message.usage.output_tokens === 20,
  );
  // willContinue:true should NOT emit a result
  const ev5 = [];
  let qq = 0;
  const mp2 = new TurnMapper('s5', (e) => ev5.push(e), () => `y${++qq}`);
  mp2.handle({ type: 'turn_end', usage: { promptTokens: 5, completionTokens: 5 }, willContinue: true });
  check('turn_end(willContinue) emits no result', !ev5.some((e) => e.payload.message.type === 'result'));
}

// selection-map: composer selections -> Bubble settings
{
  const selOut = resolve(root, 'dist-electron/_selection-map.test.mjs');
  await build({
    entryPoints: [resolve(root, 'src/electron/selection-map.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: selOut,
    logLevel: 'silent',
  });
  const { permissionModeToBubble, reasoningToThinking } = await import(pathToFileURL(selOut).href);
  console.log('\nselection-map:');
  check('permission readOnly -> plan', permissionModeToBubble('readOnly') === 'plan');
  check('permission fullAccess -> bypassPermissions', permissionModeToBubble('fullAccess') === 'bypassPermissions');
  check('permission defaultPermissions -> default', permissionModeToBubble('defaultPermissions') === 'default');
  check('permission undefined -> default', permissionModeToBubble(undefined) === 'default');
  check('reasoning high -> high', reasoningToThinking('high') === 'high');
  check('reasoning max -> max', reasoningToThinking('max') === 'max');
  check('reasoning bogus -> undefined', reasoningToThinking('bogus') === undefined);
  check('reasoning undefined -> undefined', reasoningToThinking(undefined) === undefined);
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} check(s):`, failures);
  process.exit(1);
}
console.log('\nAll verification checks passed.');

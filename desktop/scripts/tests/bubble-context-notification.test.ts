import assert from 'node:assert/strict';
import { bubbleCompactionKey, bubbleCompactionToast, normalizeCompactBoundary } from '../../src/ui/utils/bubble-context-notification.ts';
import type { StreamMessage } from '../../src/shared/types.ts';

const message: StreamMessage = { type: 'system', subtype: 'compact_boundary', uuid: 'transport', session_id: 'session',
  compactMetadata: { trigger: 'auto', preTokens: 240000, postTokens: 30000, persisted: true, compactionId: 'checkpoint' } };
const input = { sessionId: 'session', activeSessionId: 'session', session: { provider: 'bubble' }, message, seen: new Set<string>() };
const completion = bubbleCompactionToast(input)!;
assert.equal(completion.text, 'Bubble auto-compacted the conversation context (240,000 → 30,000 tokens).');
assert.equal(completion.key, bubbleCompactionKey('session', { ...message, uuid: 'replay' }));
assert.notEqual(completion.key, bubbleCompactionKey('other-session', message));
assert.equal(bubbleCompactionToast({ ...input, seen: new Set([completion.key]) }), null);
assert.equal(bubbleCompactionToast({ ...input, activeSessionId: 'background' })?.text, null);
assert.equal(bubbleCompactionToast({ ...input, session: { provider: 'bubble', hiddenFromThreads: true } })?.text, null);
assert.equal(bubbleCompactionToast({ ...input, message: { ...message, parentToolUseId: 'child' } })?.text, null);
assert.equal(bubbleCompactionToast({ ...input, message: { ...message, compactMetadata: { ...message.compactMetadata, trigger: 'manual' } } })?.text, null);
for (const persisted of [false, undefined]) {
  assert.equal(bubbleCompactionToast({ ...input, message: { ...message, compactMetadata: { ...message.compactMetadata, persisted } } }), null);
}
for (const provider of ['claude', 'codex']) {
  assert.equal(bubbleCompactionToast({ ...input, session: { provider } }), null, 'other providers remain outside Bubble policy');
}
for (const status of ['started', 'failed'] as const) {
  assert.equal(bubbleCompactionToast({ ...input, message: { type: 'system', subtype: 'compact_status', uuid: status, session_id: 'session', trigger: 'auto', status } }), null);
}
for (const postTokens of [undefined, NaN, Infinity, -1]) {
  assert.equal(bubbleCompactionToast({ ...input, message: { ...message, compactMetadata: { ...message.compactMetadata, postTokens } } })?.text,
    'Bubble auto-compacted the conversation context.');
}
assert.equal(bubbleCompactionToast({ ...input, message: { ...message, compactMetadata: { ...message.compactMetadata, postTokens: 0 } } })?.text,
  'Bubble auto-compacted the conversation context (240,000 → 0 tokens).');
// A stored boundary without metadata (older build, another adapter) must not throw while history loads.
const legacyBoundary = { ...message, compactMetadata: undefined } as unknown as typeof message;
assert.equal(bubbleCompactionKey('session', legacyBoundary), JSON.stringify(['session', message.uuid]));
assert.equal(bubbleCompactionToast({ ...input, message: legacyBoundary }), null);
// History repairs such a row once, so MessageCard / context usage can read it like any other.
assert.deepEqual(normalizeCompactBoundary(legacyBoundary).compactMetadata, { trigger: 'auto', preTokens: 0 });
assert.equal(normalizeCompactBoundary(message), message, 'well-formed rows are returned untouched');
console.log('PASS: pure Bubble compaction notification eligibility, checkpoint identity, and token formatting');

import assert from 'node:assert/strict';
import { getLatestBubbleContextSnapshot } from '../../src/ui/utils/context-usage';
import type { StreamMessage } from '../../src/shared/types';
const model = 'openai:gpt-6-astra';
const cumulative: StreamMessage = { type: 'result', subtype: 'success', model, duration_ms: 1, total_cost_usd: 0,
  usage: { input_tokens: 801160, output_tokens: 1870, total_tokens: 803030, context_window: 272000 } };
const snapshot = (usedTokens: number, estimated = false): StreamMessage => ({ type: 'system', subtype: 'bubble_context', uuid: String(usedTokens), model,
  context: { usedTokens, contextWindow: 272000, estimated } });
assert.equal(getLatestBubbleContextSnapshot([cumulative], model), null, 'legacy billing cannot produce a full context ring');
const history: StreamMessage[] = [snapshot(79228), cumulative];
assert.equal(getLatestBubbleContextSnapshot(history, model)?.percent, 29);
assert.equal(getLatestBubbleContextSnapshot(history, model)?.inputTokens, 801160, 'billing remains separate');
history.push({ type: 'system', subtype: 'compact_boundary', uuid: 'compact', session_id: 'test', compactMetadata: { trigger: 'auto', preTokens: 239000, postTokens: 30000 } }, snapshot(30000, true));
assert.equal(getLatestBubbleContextSnapshot(history, model)?.used, 30000);
assert.equal(getLatestBubbleContextSnapshot(history, model)?.estimated, true);
assert.deepEqual(getLatestBubbleContextSnapshot(JSON.parse(JSON.stringify(history)), model), getLatestBubbleContextSnapshot(history, model), 'reload preserves post-compaction occupancy');
history.push({ ...snapshot(270000), parentToolUseId: 'child' });
assert.equal(getLatestBubbleContextSnapshot(history, model)?.used, 30000, 'child usage cannot overwrite parent');
assert.equal(getLatestBubbleContextSnapshot(history, 'other:model'), null);
history.push({ type: 'system', subtype: 'bubble_context', uuid: 'invalidated', model, context: null });
assert.equal(getLatestBubbleContextSnapshot(history, model), null, 'manual compaction invalidates stale occupancy');
console.log('PASS: Bubble context uses runtime occupancy, keeps billing separate, and restores snapshots');

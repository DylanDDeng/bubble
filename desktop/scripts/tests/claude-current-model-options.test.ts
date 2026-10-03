import assert from 'node:assert/strict';
import { buildClaudeModelOptions, formatClaudeModelLabel, supportsClaude1mContext } from '../../src/ui/utils/claude-model';
import { supportsClaude1mContext as runtimeSupports1m, toClaudeCodeRuntimeModel } from '../../src/electron/libs/claude-model-selection';

const options = ['claude-fable-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5'];
assert.deepEqual(buildClaudeModelOptions({ defaultModel: null, options }), options.slice(1).filter((id) => id !== 'claude-opus-5'));
assert.ok(buildClaudeModelOptions({ defaultModel: null, options }, ['claude-fable-5']).includes('claude-fable-5'));
for (const [id, label] of [['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5', 'Sonnet 5']]) {
  assert.equal(formatClaudeModelLabel(id), label);
  assert.equal(supportsClaude1mContext(id), true);
  assert.equal(runtimeSupports1m(id), true);
  assert.equal(toClaudeCodeRuntimeModel(id), id);
}
assert.equal(formatClaudeModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
assert.equal(formatClaudeModelLabel('claude-opus-5-20260701'), 'Opus 5');
console.log('claude-current-model-options: all assertions passed');

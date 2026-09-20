import assert from 'node:assert/strict';
import type { StreamMessage } from '../../src/shared/types';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';

const workCases: StreamMessage[] = [
  { type: 'assistant', uuid: 'thinking', message: { content: [{ type: 'thinking', thinking: 'Inspecting' }] } },
  { type: 'assistant', uuid: 'commentary', phase: 'commentary', message: { content: [{ type: 'text', text: 'Inspecting' }] } },
  { type: 'assistant', uuid: 'tool', message: { content: [{ type: 'tool_use', id: 'read', name: 'read', input: {} }] } },
];
for (const work of workCases) {
  for (const withResult of [false, true]) {
    for (const retry of [false, true]) {
      const messages: StreamMessage[] = [
        { type: 'user_prompt', prompt: 'first', createdAt: 1 }, work,
        ...(withResult ? [{ type: 'result', subtype: 'error', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as StreamMessage] : []),
        { type: 'turn_failure', uuid: 'failure', error: 'connection interrupted' },
        ...(retry ? [{ type: 'user_prompt', prompt: 'retry', createdAt: 2 } as StreamMessage] : []),
      ];
      const timeline = deriveTranscriptTimelineItems(messages, {
        sessionRunning: retry,
        activeTurnStartIndex: retry ? messages.length - 1 : 0,
      });
      const workIndex = timeline.findIndex(item => item.type === 'work');
      const failureIndex = timeline.findIndex(item => item.type === 'message' && item.message.type === 'turn_failure');
      assert(workIndex >= 0 && failureIndex > workIndex, 'work must precede the failure, with or without a terminal result');
      if (retry) {
        assert.equal(timeline.at(-1)?.type, 'message');
        assert(failureIndex < timeline.length - 1, 'failure must precede retry prompt');
      }
    }
  }
}
console.log('PASS: failed-turn timeline preserves work → failure → retry ordering (12 cases)');

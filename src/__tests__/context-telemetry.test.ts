import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';
import type { AgentEvent, Provider, Message } from '../types.js';

describe('runtime context telemetry', () => {
  it('reports each request occupancy without accumulating usage or double-counting cache hits', async () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: 'text', content: 'done' };
        yield { type: 'usage', usage: { promptTokens: 60000, completionTokens: 100, promptCacheHitTokens: 59000, totalTokens: 60100 } };
        yield { type: 'done' };
      },
      async complete() { return 'summary'; },
    };
    const agent = new Agent({ provider, providerId: 'openai', model: 'openai:gpt-4o', tools: [], systemPrompt: 'test' });
    for (let turn = 0; turn < 3; turn++) {
      const events: AgentEvent[] = [];
      for await (const event of agent.run('hello', process.cwd())) events.push(event);
      const snapshots = events.filter(e => e.type === 'context_usage');
      expect(snapshots[0].estimated).toBe(true);
      expect(snapshots.at(-1)).toMatchObject({ usedTokens: 60100, contextWindow: 128000, estimated: false });
    }
  });

  for (const fail of [false, true]) it(`emits automatic compaction lifecycle on ${fail ? 'failure' : 'success'}`, async () => {
    const provider: Provider = {
      async *streamChat() { yield { type: 'text', content: 'done' }; yield { type: 'done' }; },
      async complete() { if (fail) throw new Error('summary unavailable'); return 'Earlier work summarized.'; },
    };
    const agent = new Agent({ provider, providerId: 'openai', model: 'openai:gpt-4o', tools: [], systemPrompt: 'test' });
    const old: Message[] = [{ role: 'system', content: 'test' }];
    for (let i = 0; i < 6; i++) old.push({ role: 'user', content: `old ${i}` }, { role: 'assistant', content: 'old work '.repeat(30000) });
    agent.messages = old;
    const events: AgentEvent[] = [];
    for await (const event of agent.run('continue', process.cwd())) events.push(event);
    const compactions = events.filter(e => e.type === 'context_compaction');
    expect(compactions[0]).toMatchObject({ status: 'started' });
    expect(compactions[1]).toMatchObject({ status: fail ? 'failed' : 'completed' });
    if (!fail) expect(compactions[1].postTokens).toBeLessThan(compactions[1].preTokens);
    expect(events.findIndex(e => e.type === 'context_usage')).toBeGreaterThan(events.indexOf(compactions[1]));
  });
});

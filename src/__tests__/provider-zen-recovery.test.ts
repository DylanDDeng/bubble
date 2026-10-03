import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent.js';
import { createProviderInstance } from '../provider.js';
import { createSanitizedProviderError } from '../provider-error-record.js';
import { chatRequestShape, recoverableSpaceBunnyError } from '../provider-zen-errors.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn().mockImplementation(function () {
  return { chat: { completions: { create } } };
}) }));
const rejection = () => Object.assign(new Error('422 Upstream request failed: [invalid_request_error] unprocessable entity'), {
  status: 422, code: 'invalid_request_error',
});
const zen = () => createProviderInstance({ providerId: 'opencode-zen', apiKey: 'test', baseURL: 'https://example.invalid/v1', protocol: 'openai-chat' });
const options = { model: 'space-bunny-free', thinkingLevel: 'max' as const };
const messages = [{ role: 'user' as const, content: 'synthetic probe' }];
async function* chunks(items: any[]) { yield* items; }
async function collect(stream: AsyncIterable<unknown>) { const events = []; for await (const e of stream) events.push(e); return events; }
const toolChunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'probe-1', type: 'function', function: { name: 'probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
const answer = { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
let dir: string;
beforeEach(() => { create.mockReset(); dir = mkdtempSync(join(tmpdir(), 'zen-recovery-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Space Bunny scoped upstream recovery', () => {
  it('retries the same request after tool execution without replaying the tool', async () => {
    const execute = vi.fn(async () => ({ content: 'probe result' }));
    create.mockResolvedValueOnce(chunks([toolChunk])).mockRejectedValueOnce(rejection()).mockResolvedValueOnce(chunks([answer]));
    const agent = new Agent({ provider: zen(), model: options.model, tools: [{
      name: 'probe', description: 'Synthetic probe', parameters: { type: 'object', properties: {} }, execute,
    }] });
    const events = await collect(agent.run('Use probe', dir));
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[2][0]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'provider_retry', attempt: 1, maxAttempts: 2 }));
    expect(agent.messages.filter(m => m.role === 'tool')).toHaveLength(1);
  });

  it('discards an interrupted tool-call stream before any tool executes', async () => {
    const execute = vi.fn(async () => ({ content: 'probe result' }));
    create.mockResolvedValueOnce((async function* () { yield toolChunk; throw rejection(); })())
      .mockResolvedValueOnce(chunks([toolChunk])).mockResolvedValueOnce(chunks([answer]));
    const agent = new Agent({ provider: zen(), model: options.model, tools: [{
      name: 'probe', description: 'Synthetic probe', parameters: { type: 'object', properties: {} }, execute,
    }] });
    await collect(agent.run('Use probe', dir));
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('caps a persistent opaque 422 at three total requests', async () => {
    create.mockRejectedValue(rejection());
    const agent = new Agent({ provider: zen(), model: options.model, tools: [] });
    await expect(collect(agent.run('test', dir))).rejects.toThrow('422');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['opencode-zen', 'space-bunny-free', Object.assign(new Error('invalid tool schema'), { status: 422 })],
    ['opencode-zen', 'another-model', rejection()],
    ['openai', 'space-bunny-free', rejection()],
  ])('does not retry other validation errors or models (%s %s)', async (providerId, model, error) => {
    create.mockRejectedValue(error);
    const provider = createProviderInstance({ providerId, apiKey: 'test', baseURL: 'https://example.invalid/v1', protocol: 'openai-chat' });
    await expect(collect(provider.streamChat(messages, { model }))).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('cancels recovery when the user stops at the retry event', async () => {
    create.mockRejectedValue(rejection());
    const controller = new AbortController();
    const agent = new Agent({ provider: zen(), model: options.model, tools: [] });
    try {
      for await (const event of agent.run('test', dir, { abortSignal: controller.signal })) {
        if (event.type === 'provider_retry') controller.abort();
      }
    } catch { /* cancellation */ }
    expect(controller.signal.aborted).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries nonstream completions with the same body and a finite budget', async () => {
    create.mockRejectedValueOnce(rejection()).mockResolvedValueOnce({ choices: [{ message: { content: 'OK' } }] });
    expect(await zen().complete(messages, options)).toBe('OK');
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
    create.mockReset().mockRejectedValue(rejection());
    await expect(zen().complete(messages, options)).rejects.toThrow('422');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('records allowlisted shape counters without request content', () => {
    const shape = chatRequestShape({ messages: [
      { role: 'assistant', content: '', reasoning_content: 'private reasoning', tool_calls: [{ secret: 'args' }] },
      { role: 'tool', content: 'secret' },
    ], tools: [{ secret: 'schema' }] });
    const error = Object.assign(recoverableSpaceBunnyError(rejection()), { requestShape: {
      ...shape, messages: 'secret', tools: -1, reasoning: NaN, injected: 'private payload',
    } });
    const record = createSanitizedProviderError(error, { providerId: 'opencode-zen', modelId: options.model, thinkingLevel: 'max', messageCount: 2, toolCount: 1 });
    expect(record).toMatchObject({ httpStatus: 422, code: 'invalid_request_error', requestShape: { assistant: 1, toolCalls: 1, toolResults: 1, contentChars: 6 } });
    expect(JSON.stringify(record)).not.toMatch(/private|secret|injected|NaN/);
    expect(record.requestShape).not.toHaveProperty('messages');
    expect(record.requestShape).not.toHaveProperty('tools');
    expect(record.requestShape).not.toHaveProperty('reasoning');
  });
});

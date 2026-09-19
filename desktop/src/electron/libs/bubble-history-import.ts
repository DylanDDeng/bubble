import type { StreamMessage, ContentBlock } from '../../shared/types';
import { getBubbleSdk } from './provider/bubble-sdk-loader';
import { importBubbleHistorySnapshot } from './session-store';
import { app } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const text = (value: unknown): string => typeof value === 'string' ? value :
  Array.isArray(value) ? value.map(part => part?.type === 'text' ? part.text : '[Image]').join('\n') : '';

/** Adapt persisted SDK messages without changing the source JSONL files. */
export function bubbleHistoryMessages(history: unknown[], sourceId: string): StreamMessage[] {
  return history.flatMap((entry, index): StreamMessage[] => {
    const message = entry as Record<string, any>;
    const uuid = `bubble-import:${sourceId}:${index}`;
    const createdAt = typeof message.timestamp === 'number' ? message.timestamp : undefined;
    if (message.role === 'user') return [{ type: 'user_prompt', prompt: text(message.content), createdAt }];
    if (message.role === 'assistant') {
      const content: ContentBlock[] = [];
      if (message.reasoning) content.push({ type: 'thinking', thinking: message.reasoning });
      if (message.content) content.push({ type: 'text', text: text(message.content) });
      for (const call of message.toolCalls || []) {
        let input = call.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { raw: input }; } }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: input || {} });
      }
      return content.length ? [{ type: 'assistant', uuid, createdAt, message: { content } }] : [];
    }
    if (message.role === 'tool') return [{ type: 'user', uuid, createdAt, message: {
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: text(message.content), is_error: !!message.isError }],
    } }];
    return [];
  });
}

export async function importBubbleHistory(): Promise<number> {
  const marker = join(app.getPath('userData'), 'bubble-history-import-v1.json');
  if (existsSync(marker)) return 0;
  const sdk = await getBubbleSdk();
  let count = 0;
  for (const item of sdk.listSessions()) {
    if (importBubbleHistorySnapshot(item, () => bubbleHistoryMessages(sdk.getHistory(item.name), item.name))) count++;
  }
  writeFileSync(marker, JSON.stringify({ importedAt: Date.now(), count }));
  return count;
}

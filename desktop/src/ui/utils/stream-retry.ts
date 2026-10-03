import type { SessionStatus, StreamMessage } from '../types';

export function activeStreamRetry(messages: StreamMessage[], status: SessionStatus) {
  if (status !== 'running') return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    // Child activity and tool results do not prove the parent reconnected.
    if (message.parentToolUseId) continue;
    if (message.type === 'system' && message.subtype === 'api_retry') return message;
    if (message.type === 'system' && message.subtype === 'api_retry_resolved') return null;
    if (message.type === 'assistant' || message.type === 'result' || message.type === 'user_prompt') return null;
    if (message.type === 'stream_event' && message.event.type === 'content_block_delta') return null;
  }
  return null;
}

export function streamRetryLabel(retry: NonNullable<ReturnType<typeof activeStreamRetry>>) {
  const attempts = retry.maxRetries > 0 ? ` ${retry.attempt}/${retry.maxRetries}` : '';
  if (retry.errorStatus === null) return `Reconnecting${attempts}`;
  const kind = retry.errorStatus === 429 ? 'Rate limited'
    : retry.errorStatus === 503 || retry.errorStatus === 529 ? 'Server overloaded' : `API error (${retry.errorStatus})`;
  const delay = retry.delayMs === undefined ? '' : ` in ${Math.max(1, Math.round(retry.delayMs / 1000))}s`;
  return `${kind} · retrying${attempts}${delay}`;
}

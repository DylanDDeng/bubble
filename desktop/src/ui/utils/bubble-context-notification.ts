import type { CompactMetadata, StreamMessage } from '../../shared/types';

/** Checkpoint identity wins over transport UUIDs, which can change on replay. */
export function bubbleCompactionKey(sessionId: string, message: StreamMessage): string | null {
  if (message.type !== 'system' || message.subtype !== 'compact_boundary') return null;
  const id = message.compactMetadata?.compactionId || message.uuid;
  return id ? JSON.stringify([sessionId, id]) : null;
}

export function bubbleCompactionToast(input: {
  sessionId: string;
  activeSessionId: string | null;
  session?: { provider?: string; hiddenFromThreads?: boolean };
  message: StreamMessage;
  seen: ReadonlySet<string>;
}): { key: string; text: string | null } | null {
  const { sessionId, activeSessionId, session, message, seen } = input;
  if (session?.provider !== 'bubble' || message.type !== 'system' || message.subtype !== 'compact_boundary'
    || message.compactMetadata?.persisted !== true) return null;
  const key = bubbleCompactionKey(sessionId, message);
  if (!key || seen.has(key)) return null;
  // Even ineligible live completions are consumed: switching to a background
  // thread must not turn a replay into a new foreground notification.
  const eligible = activeSessionId === sessionId && !session.hiddenFromThreads
    && !message.parentToolUseId && message.compactMetadata.trigger === 'auto';
  return { key, text: eligible ? completionText(message.compactMetadata) : null };
}

function completionText(metadata: CompactMetadata): string {
  const valid = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const tokens = valid(metadata.preTokens) && valid(metadata.postTokens)
    ? ` (${metadata.preTokens.toLocaleString('en-US')} → ${metadata.postTokens.toLocaleString('en-US')} tokens)`
    : '';
  return `Bubble auto-compacted the conversation context${tokens}.`;
}

/** Rows come from SQLite, not the type system: an older build or another adapter
 * may have persisted a compact boundary without metadata. Every consumer
 * (message card, context usage, notifications) reads `compactMetadata` directly,
 * so repair the row once where history enters the store. */
export function normalizeCompactBoundary(message: StreamMessage): StreamMessage {
  if (message.type !== 'system' || message.subtype !== 'compact_boundary' || message.compactMetadata) return message;
  // Missing metadata is no evidence of why it was compacted: say so, rather than
  // label it automatic (or manual) in the timeline.
  return { ...message, compactMetadata: { trigger: 'unknown', preTokens: 0 } };
}

import * as sessions from '../../session-store';
import { recoverBubbleHistoryContext } from '../../bubble-history-context';
import { endIndexAfterTopLevelCount, startIndexForTopLevelCount } from '../page-boundaries';
import type {
  SessionHistorySource,
  UnifiedHistoryPage,
  UnifiedSessionRecord,
} from '../types';

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number {
  const parsed = Number(cursor);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRenderableMessages(sessionId: string) {
  return sessions.getSessionHistory(sessionId).filter((message) => message.type !== 'stream_event');
}

export class AegisDbHistorySource implements SessionHistorySource {
  readonly kind = 'aegis' as const;

  // Page budgets count only top-level messages; hidden subagent (Task)
  // messages ride along with their slice so a chatty Task can't fill a page
  // with rows the transcript never renders. See page-boundaries.ts.
  async loadLatest(session: UnifiedSessionRecord, limit: number): Promise<UnifiedHistoryPage> {
    let messages = getRenderableMessages(session.id);
    let recovered = null;
    const row = session.provider === 'bubble' ? sessions.getSession(session.id) : null;
    if (row && ['idle', 'completed', 'error'].includes(row.status) &&
        !messages.some(m => !m.parentToolUseId && m.type === 'system' && m.subtype === 'bubble_context')) {
      recovered = await recoverBubbleHistoryContext(row, messages);
      // Opening history can overlap with sending a new turn. Never append an
      // old measurement after a newly persisted runtime snapshot.
      const current = sessions.getSession(session.id);
      const currentMessages = getRenderableMessages(session.id);
      if (!current || current.status !== row.status || current.updated_at !== row.updated_at ||
          current.bubble_session_id !== row.bubble_session_id || current.model !== row.model ||
          currentMessages.length !== messages.length || currentMessages.some(m =>
            !m.parentToolUseId && m.type === 'system' && m.subtype === 'bubble_context')) recovered = null;
      messages = currentMessages;
    }
    const safeLimit = Math.max(1, limit);
    const start = startIndexForTopLevelCount(messages, messages.length, safeLimit);
    return {
      // Synthesized telemetry is not stored and does not consume a page offset.
      messages: [...messages.slice(start), ...(recovered ? [recovered] : [])],
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadBefore(session: UnifiedSessionRecord, cursor: string, limit: number): Promise<UnifiedHistoryPage> {
    const messages = getRenderableMessages(session.id);
    const offset = Math.max(0, decodeCursor(cursor));
    const safeLimit = Math.max(1, limit);
    const start = startIndexForTopLevelCount(messages, offset, safeLimit);
    return {
      messages: messages.slice(start, offset),
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadAround(
    session: UnifiedSessionRecord,
    anchorCreatedAt: number,
    before: number,
    after: number
  ): Promise<UnifiedHistoryPage> {
    const messages = getRenderableMessages(session.id);
    const anchorIndex = messages.findIndex((message) => message.createdAt === anchorCreatedAt);
    if (anchorIndex === -1) {
      throw new Error('Target message not found in session history.');
    }

    const safeBefore = Math.max(0, before);
    const safeAfter = Math.max(0, after);
    const start = startIndexForTopLevelCount(messages, anchorIndex, safeBefore);
    const end = endIndexAfterTopLevelCount(messages, anchorIndex + 1, safeAfter);

    return {
      messages: messages.slice(start, end),
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadAll(session: UnifiedSessionRecord) {
    return getRenderableMessages(session.id);
  }
}

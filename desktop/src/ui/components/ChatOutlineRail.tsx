import { useEffect, useMemo, useState } from 'react';
import { Paperclip } from './icons';
import { FileTypeIcon } from './FileTypeIcon';
import { OutlineRail } from './OutlineRail';
import type { SessionUserPromptSummary } from '../types';

const MAX_CARD_CHIPS = 3;

/**
 * Footer chips: files the turn changed (with file-type icons); when the turn
 * touched nothing, fall back to the prompt's attachments.
 */
function OutlineCardChips({ item }: { item: SessionUserPromptSummary }) {
  const files = item.changedFiles;
  const names = files.length > 0 ? files : item.attachmentNames;
  if (names.length === 0) {
    return null;
  }
  const hasBodyAbove = Boolean(item.text || item.replyText);

  return (
    <div className={`flex items-center gap-2.5 overflow-hidden ${hasBodyAbove ? 'mt-2.5' : ''}`}>
      {names.slice(0, MAX_CARD_CHIPS).map((name, index) => (
        <span
          key={`${name}-${index}`}
          className="inline-flex min-w-0 flex-shrink items-center gap-1 text-[11.5px] text-[var(--text-secondary)]"
        >
          {files.length > 0 ? (
            <FileTypeIcon name={name} className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Paperclip className="h-3 w-3 flex-shrink-0" />
          )}
          <span className="truncate">{name}</span>
        </span>
      ))}
      {names.length > MAX_CARD_CHIPS ? (
        <span className="flex-shrink-0 text-[11.5px] text-[var(--text-muted)]">
          +{names.length - MAX_CARD_CHIPS}
        </span>
      ) : null}
    </div>
  );
}

export function ChatOutlineRail({
  sessionId,
  livePrompts,
  onNavigate,
}: {
  sessionId: string;
  livePrompts: SessionUserPromptSummary[];
  onNavigate: (createdAt: number) => void;
}) {
  const [fetched, setFetched] = useState<SessionUserPromptSummary[]>([]);
  const [fetchedSessionId, setFetchedSessionId] = useState<string | null>(null);
  // Refetch on session switch and when the loaded prompt count changes (new
  // prompt sent, rewind) so the index never drifts far from the DB.
  const livePromptCount = livePrompts.length;
  useEffect(() => {
    let cancelled = false;

    window.electron
      .getSessionUserPrompts(sessionId)
      .then((summaries) => {
        if (cancelled) return;
        setFetched(summaries);
        setFetchedSessionId(sessionId);
      })
      .catch(() => {
        // Sessions without a backing store (drafts, just-imported) simply
        // fall back to the loaded messages.
        if (cancelled) return;
        setFetched([]);
        setFetchedSessionId(sessionId);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, livePromptCount]);

  const items = useMemo(() => {
    const byCreatedAt = new Map<number, SessionUserPromptSummary>();
    // Ignore a stale fetch from the previously viewed session.
    if (fetchedSessionId === sessionId) {
      for (const summary of fetched) {
        byCreatedAt.set(summary.createdAt, summary);
      }
    }
    // Live summaries win: they track the streaming turn (reply text and
    // changed files grow as the agent works) while the fetch is a snapshot.
    for (const prompt of livePrompts) {
      byCreatedAt.set(prompt.createdAt, prompt);
    }
    return [...byCreatedAt.values()].sort((left, right) => left.createdAt - right.createdAt);
  }, [fetched, fetchedSessionId, livePrompts, sessionId]);

  if (items.length < 2) return null;
  return <OutlineRail key={sessionId} label="Conversation outline" className="bubble-outline-chat"
    items={items.map(item => ({ id: String(item.createdAt), title: item.text || 'Message with attachments', summary: item.replyText, footer: <OutlineCardChips item={item} /> }))}
    onNavigate={id => onNavigate(Number(id))} />;
}

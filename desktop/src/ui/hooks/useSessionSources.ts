import { useEffect, useMemo, useState } from 'react';
import type { Attachment, SessionView } from '../types';
import { collectSessionSources, mergeSessionSources } from '../../shared/session-sources';

export function useSessionSources(session: SessionView | null) {
  const sessionId = session?.id ?? null;
  const [history, setHistory] = useState<{ sessionId: string; sources: Attachment[]; error: string | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const local = useMemo(() => collectSessionSources(session?.messages ?? []), [session?.messages]);
  const localKey = JSON.stringify(local.map(source => source.path));
  useEffect(() => {
    if (!sessionId || session?.isDraft) return;
    let cancelled = false;
    void window.electron.getSessionSources(sessionId).then(sources => {
      if (!cancelled) setHistory({ sessionId, sources, error: null });
    }).catch(() => {
      if (!cancelled) setHistory({ sessionId, sources: [], error: 'Could not load earlier attachments.' });
    });
    return () => { cancelled = true; };
  }, [sessionId, session?.isDraft, localKey, revision]);
  const current = history?.sessionId === sessionId ? history : null;
  return {
    sources: useMemo(() => mergeSessionSources(current?.sources ?? [], local), [current, local]),
    loading: Boolean(sessionId && !session?.isDraft && !current),
    error: current?.error ?? null,
    refresh: () => setRevision(value => value + 1),
  };
}

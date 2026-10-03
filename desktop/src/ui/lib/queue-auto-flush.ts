import type { AgentProvider } from '../types';
import { useAppStore } from '../store/useAppStore';
import {
  hasQueueFlushOwner,
  subscribeQueueFlushOwners,
  useComposerQueueStore,
  type QueuedComposerMessage,
} from '../store/useComposerQueueStore';
import { sendEvent } from '../hooks/useIPC';
import { isSessionEffectivelyBusy } from '../utils/workstream';

// Both visible composers and the background watcher use the same reservation.
// A completed status can linger until IPC acknowledges the next turn; split
// panes and exclusive batches must not dispatch again in that window.
const dispatched = new Set<string>();
let started = false;
const scheduled = new Set<string>();
const queued = new Set<string>();

export function flushCompletedQueue(
  sessionId: string,
  dispatch: (items: QueuedComposerMessage[]) => void,
): void {
  const session = useAppStore.getState().sessions[sessionId];
  const status = session?.status;
  if (status !== 'completed') {
    dispatched.delete(sessionId);
    return;
  }
  if (isSessionEffectivelyBusy(status, session.messages)) return;
  if (dispatched.has(sessionId) || !window.electron?.sendClientEvent) return;
  if (!useComposerQueueStore.getState().queues[sessionId]?.length) return;
  dispatched.add(sessionId);
  const items = useComposerQueueStore.getState().takeNextBatch(sessionId);
  if (items[0].exclusive && items[0].dispatch) items[0].dispatch();
  else dispatch(items);
}

function scheduleUnownedFlush(sessionId: string): void {
  if (scheduled.has(sessionId)) return;
  scheduled.add(sessionId);
  queueMicrotask(() => {
    scheduled.delete(sessionId);
    if (hasQueueFlushOwner(sessionId)) return;
    flushCompletedQueue(sessionId, items => {
      dispatchBackgroundBatch(sessionId, useAppStore.getState().sessions[sessionId]?.provider, items);
    });
  });
}

/** Watch queue readiness, including enqueue-after-completion and pane teardown.
 * Failed/stopped turns retain their queued messages for an explicit retry.
 */
export function startQueueAutoFlush(): void {
  if (started) return;
  started = true;
  useAppStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return;
    // Streaming changes the sessions map on every flush. Only sessions with
    // queued work or an in-flight dispatch can need queue reconciliation.
    const candidates = new Set([...queued, ...dispatched]);
    for (const sessionId of candidates) {
      const session = state.sessions[sessionId];
      if (!session) { dispatched.delete(sessionId); continue; }
      if (session.status !== 'completed') dispatched.delete(sessionId);
      const before = previous.sessions[sessionId];
      if (session.status !== before?.status ||
        (session.status === 'completed' && session.messages !== before?.messages)) {
        scheduleUnownedFlush(sessionId);
      }
    }
  });
  useComposerQueueStore.subscribe((state, previous) => {
    queued.clear();
    for (const [sessionId, queue] of Object.entries(state.queues)) {
      if (queue.length) queued.add(sessionId);
      if (queue.length && queue !== previous.queues[sessionId]) scheduleUnownedFlush(sessionId);
    }
  });
  subscribeQueueFlushOwners(scheduleUnownedFlush);
  for (const [sessionId, queue] of Object.entries(useComposerQueueStore.getState().queues)) {
    if (queue.length) { queued.add(sessionId); scheduleUnownedFlush(sessionId); }
  }
}

function dispatchBackgroundBatch(sessionId: string, provider: AgentProvider | undefined, items: QueuedComposerMessage[]): void {
  const attachments = items.flatMap((item) => item.attachments);
  sendEvent({
    type: 'session.continue',
    payload: {
      sessionId,
      prompt: items.map((item) => item.displayPrompt).join('\n\n'),
      effectivePrompt: items.map((item) => item.effectivePrompt).join('\n\n'),
      attachments: attachments.length > 0 ? attachments : undefined,
      provider,
      codexSkills: items.flatMap((item) => item.references.codexSkills ?? []),
      codexMentions: items.flatMap((item) => item.references.codexMentions ?? []),
      teamMode: 'solo',
      teamId: null,
    },
  });
}

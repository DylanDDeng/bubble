import { useAppStore } from '../store/useAppStore';
import { useComposerQueueStore } from '../store/useComposerQueueStore';
import { isSessionEffectivelyBusy } from '../utils/workstream';
import { loadPreferredBubblePermissionMode, toBubblePlanExitMode } from '../utils/bubble-permission';
import { loadPreferredBubbleThinkingLevel } from '../utils/bubble-reasoning';
import type { Attachment, DesignPromptRef } from '../types';

/** Only Bubble turns receive the design host tools. */
export function canSendDesignComment(sessionId: string | null | undefined) {
  const session = sessionId ? useAppStore.getState().sessions[sessionId] : undefined;
  return !!session && !session.readOnly && !session.isDraft && session.provider === 'bubble';
}

/**
 * Sends a design comment as its own turn. The transcript shows `prompt`; the
 * model receives `effectivePrompt`. While a turn runs it waits in the queue as
 * an exclusive item: steering cannot carry the screenshot attachment.
 */
export function sendDesignComment(input: {
  sessionId: string;
  prompt: string;
  effectivePrompt: string;
  attachments: Attachment[];
  design: DesignPromptRef;
  onRemove?: () => void;
}): 'sent' | 'queued' {
  const { sessionId, prompt, effectivePrompt, attachments, design } = input;
  if (!canSendDesignComment(sessionId)) throw new Error('Comments reach Bubble only in a Bubble conversation.');
  const dispatch = () => {
    const session = useAppStore.getState().sessions[sessionId];
    if (!session || session.readOnly || session.provider !== 'bubble') return;
    if (!window.electron.sendClientEvent) throw new Error('The agent connection is unavailable.');
    // Same configuration the composer sends: a fresh runner otherwise falls
    // back to the default permission mode and asks to approve design_update.
    const preferred = loadPreferredBubblePermissionMode();
    window.electron.sendClientEvent({ type: 'session.continue', payload: {
      sessionId, prompt, effectivePrompt, attachments, provider: 'bubble', design,
      model: session.model,
      bubblePermissionMode: session.bubblePermissionMode === 'plan' ? 'plan' : preferred,
      bubblePlanExitMode: toBubblePlanExitMode(preferred),
      bubbleThinkingLevel: loadPreferredBubbleThinkingLevel(session.model ?? null) ?? undefined,
      teamMode: 'solo', teamId: null,
    } });
  };
  const session = useAppStore.getState().sessions[sessionId]!;
  const busy = session.status === 'running' || session.status === 'stopping'
    || session.permissionRequests.length > 0
    || isSessionEffectivelyBusy(session.status, session.messages);
  if (!busy) {
    dispatch();
    return 'sent';
  }
  useComposerQueueStore.getState().enqueue(sessionId, {
    id: crypto.randomUUID(), displayPrompt: prompt, effectivePrompt, attachments, references: {},
    exclusive: true, dispatch, design, onRemove: input.onRemove,
  });
  return 'queued';
}

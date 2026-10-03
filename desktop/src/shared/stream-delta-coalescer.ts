import type { StreamMessage } from './types';

/**
 * Batches adjacent text/thinking deltas on a 33 ms deadline. Used by the
 * Bubble adapter before main-process/IPC work and by the renderer before
 * store updates. Every non-delta boundary flushes first; callers must also
 * flush or discard on status changes and teardown to preserve ordering.
 * Uses a deadline rather than a debounce or rAF so background windows keep
 * receiving output and continuous streams cannot starve the flush.
 */

export type CoalescerEmit = (payload: { sessionId: string; message: StreamMessage }) => void;

interface DeltaBuffer {
  /** Content-block index the buffered deltas belong to. */
  index: number | undefined;
  deltaType: 'text_delta' | 'thinking_delta';
  text: string;
}

interface SessionBuffer {
  buffer: DeltaBuffer;
  cancelTimer: () => void;
}

export interface StreamDeltaCoalescerOptions {
  /** Deadline from the first buffered delta to the timer flush. */
  flushMs?: number;
  /** Flush immediately once a buffer accumulates this many characters. */
  maxChars?: number;
  /**
   * Timer injection for tests. Must return a cancel function. Defaults to
   * setTimeout/clearTimeout.
   */
  schedule?: (callback: () => void, ms: number) => () => void;
}

const DEFAULT_FLUSH_MS = 33;
const DEFAULT_MAX_CHARS = 8192;

type CoalescibleDelta = {
  index: number | undefined;
  deltaType: 'text_delta' | 'thinking_delta';
  text: string;
};

/**
 * A main-agent text/thinking delta is the only coalescible shape. Everything
 * else (content_block_start/stop, signature deltas, subagent events,
 * assistant/user/system/result messages) passes through untouched after a
 * flush.
 */
function asCoalescibleDelta(message: StreamMessage): CoalescibleDelta | null {
  if (message.type !== 'stream_event') {
    return null;
  }
  if (message.parentToolUseId) {
    return null;
  }
  const event = message.event;
  if (!event || event.type !== 'content_block_delta' || !event.delta) {
    return null;
  }
  if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
    return { index: event.index, deltaType: 'text_delta', text: event.delta.text };
  }
  if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
    return { index: event.index, deltaType: 'thinking_delta', text: event.delta.thinking };
  }
  return null;
}

function buildDeltaMessage(buffer: DeltaBuffer): StreamMessage {
  return {
    type: 'stream_event',
    parentToolUseId: null,
    event: {
      type: 'content_block_delta',
      index: buffer.index,
      delta:
        buffer.deltaType === 'text_delta'
          ? { type: 'text_delta', text: buffer.text }
          : { type: 'thinking_delta', thinking: buffer.text },
    },
  };
}

export class StreamDeltaCoalescer {
  private readonly flushMs: number;
  private readonly maxChars: number;
  private readonly schedule: (callback: () => void, ms: number) => () => void;
  private readonly sessions = new Map<string, SessionBuffer>();
  private emit: CoalescerEmit = () => {};

  constructor(options: StreamDeltaCoalescerOptions = {}) {
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.schedule =
      options.schedule ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        return () => clearTimeout(handle);
      });
  }

  /** Bind (or rebind) the flush target. Idempotent; safe to call per event. */
  setEmitter(emit: CoalescerEmit): void {
    this.emit = emit;
  }

  /**
   * Route a `stream.message` payload. Returns true when the message was
   * absorbed into a buffer (caller must NOT process it); false when the
   * caller should process it normally (any buffered tail for the session has
   * already been flushed, preserving order).
   */
  push(payload: { sessionId: string; message: StreamMessage }): boolean {
    const { sessionId, message } = payload;
    const delta = asCoalescibleDelta(message);
    if (!delta) {
      this.flushSession(sessionId);
      return false;
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      const sameKey =
        existing.buffer.index === delta.index && existing.buffer.deltaType === delta.deltaType;
      if (!sameKey) {
        // Key change (new content block / text↔thinking switch): flush the
        // old run first so cross-block ordering is preserved.
        this.flushSession(sessionId);
      } else {
        existing.buffer.text += delta.text;
        if (existing.buffer.text.length >= this.maxChars) {
          this.flushSession(sessionId);
        }
        return true;
      }
    }

    const cancelTimer = this.schedule(() => this.flushSession(sessionId), this.flushMs);
    this.sessions.set(sessionId, {
      buffer: { index: delta.index, deltaType: delta.deltaType, text: delta.text },
      cancelTimer,
    });
    return true;
  }

  /** Emit any buffered tail for the session, in order, and clear its timer. */
  flushSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }
    this.sessions.delete(sessionId);
    entry.cancelTimer();
    if (entry.buffer.text.length > 0) {
      this.emit({ sessionId, message: buildDeltaMessage(entry.buffer) });
    }
  }

  /**
   * Drop any buffered tail without emitting. Used when the session's
   * streaming state is being cleared (stop/idle status, user-prompt echo,
   * history reload, session delete) — emitting after the clear would revive
   * a ghost streaming bubble that nothing ever cleans up.
   */
  discardSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }
    this.sessions.delete(sessionId);
    entry.cancelTimer();
  }

  /** Flush every session (used ahead of events without a session scope). */
  flushAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.flushSession(sessionId);
    }
  }

  /** Test hook: number of sessions with a live buffer. */
  pendingSessionCount(): number {
    return this.sessions.size;
  }
}

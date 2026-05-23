/**
 * Per-scope inbound message debounce. Coalesces messages arriving within
 * `debounceMs` of each other into a single prompt, so a user typing
 * fragments doesn't kick off N parallel runs.
 *
 * Lifecycle per scopeKey:
 *   push(scopeKey, msg) → start/reset timer
 *   timer fires → flush queued messages as combined prompt, call onFlush()
 *   block(scopeKey) → suppress flushes until unblock() (used while a run is in flight)
 *   unblock(scopeKey) → resume; if queue non-empty, flush immediately
 */

import type { ScopeKey } from "../types.js";

export interface QueuedMessage {
  text: string;
  messageId: string;
  receivedAt: number;
}

interface ScopeState {
  messages: QueuedMessage[];
  timer?: NodeJS.Timeout;
  blocked: boolean;
}

export interface PendingQueueOptions {
  debounceMs: number;
  onFlush: (scopeKey: ScopeKey, batch: QueuedMessage[]) => void | Promise<void>;
}

export class PendingQueue {
  private readonly states = new Map<ScopeKey, ScopeState>();

  constructor(private readonly opts: PendingQueueOptions) {}

  push(scopeKey: ScopeKey, msg: QueuedMessage): void {
    let state = this.states.get(scopeKey);
    if (!state) {
      state = { messages: [], blocked: false };
      this.states.set(scopeKey, state);
    }
    state.messages.push(msg);
    if (state.blocked) return;
    this.resetTimer(scopeKey);
  }

  /** Suspend flushing for `scopeKey` while a run is in flight. */
  block(scopeKey: ScopeKey): void {
    let state = this.states.get(scopeKey);
    if (!state) {
      state = { messages: [], blocked: true };
      this.states.set(scopeKey, state);
      return;
    }
    state.blocked = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  unblock(scopeKey: ScopeKey): void {
    const state = this.states.get(scopeKey);
    if (!state) return;
    state.blocked = false;
    if (state.messages.length > 0) {
      // Flush immediately — debounce already elapsed conceptually while we
      // were blocked.
      void this.flush(scopeKey);
    }
  }

  /** Stop all timers (used at shutdown). Does not flush. */
  shutdown(): void {
    for (const state of this.states.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
    this.states.clear();
  }

  private resetTimer(scopeKey: ScopeKey): void {
    const state = this.states.get(scopeKey);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void this.flush(scopeKey);
    }, this.opts.debounceMs);
  }

  private async flush(scopeKey: ScopeKey): Promise<void> {
    const state = this.states.get(scopeKey);
    if (!state) return;
    if (state.blocked) return;
    if (state.messages.length === 0) return;
    const batch = state.messages;
    state.messages = [];
    state.timer = undefined;
    try {
      await this.opts.onFlush(scopeKey, batch);
    } catch {
      // Errors are caller's responsibility to surface; never crash the queue.
    }
  }
}

/** Concatenate queued messages into a single user prompt. */
export function combineQueuedMessages(batch: QueuedMessage[]): string {
  if (batch.length === 1) return batch[0]!.text;
  return batch.map((m) => m.text).join("\n\n");
}

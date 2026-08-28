/**
 * Ctrl+B send-to-background promotion channel (background-tasks design §2.5).
 *
 * A running foreground bash tool call registers a promotion handler keyed by
 * its toolCall id at spawn; the TUI requests promotion when the user presses
 * Ctrl+B. The handler returns the new task id on success, or undefined when
 * it is too late (the command already reached a terminal state — exit,
 * timeout, cancel — a benign race, not an error).
 */

export type PromotionHandler = () => string | undefined;

export class PromotionChannel {
  private readonly handlers = new Map<string, PromotionHandler>();

  register(toolCallId: string, handler: PromotionHandler): () => void {
    this.handlers.set(toolCallId, handler);
    return () => {
      if (this.handlers.get(toolCallId) === handler) {
        this.handlers.delete(toolCallId);
      }
    };
  }

  /** Returns the promoted task id, or undefined when nothing was promotable. */
  requestPromotion(toolCallId: string): string | undefined {
    const handler = this.handlers.get(toolCallId);
    if (!handler) return undefined;
    return handler();
  }

  hasPromotable(toolCallId: string): boolean {
    return this.handlers.has(toolCallId);
  }
}

/**
 * Composer submission payload — the bridge type between the composer UI and
 * the agent input path. Lives in the renderer-neutral model layer so the
 * queue state machine can reference it without importing tui-ink.
 */
export interface SubmitPayload {
  /** Fully-expanded text sent to the agent. */
  text: string;
  /** Text shown in the composer/transcript when it differs from the real text. */
  displayText?: string;
  images: import("../../tui-ink/image-paste.js").ImageAttachment[];
  /** First UI-only [Image #N] label reserved for this submitted payload. */
  imageDisplayStart?: number;
  /** Harness-initiated submission; runs hidden (task wake path). */
  internal?: "task_wake";
}

/**
 * Pure scroll arithmetic for the alt-screen transcript viewport.
 *
 * Mirrors the live OpenTUI scrollbox semantics (src/tui/run.ts
 * transcriptMaxScrollTop / isTranscriptAtBottom): "at bottom" tolerates a
 * one-line slack so sub-line rounding never flips the follow flag while the
 * user sits at the end of the transcript.
 */

export function maxScrollTop(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}

export function clampScrollTop(
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  return Math.max(0, Math.min(scrollTop, maxScrollTop(contentHeight, viewportHeight)));
}

export function isAtBottom(
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number,
): boolean {
  return scrollTop >= maxScrollTop(contentHeight, viewportHeight) - 1;
}

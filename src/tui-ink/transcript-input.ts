export type TranscriptPageScrollDirection = "up" | "down";

export interface TranscriptKeyEvent {
  pageUp?: boolean;
  pageDown?: boolean;
}

export function transcriptPageScrollDirection(
  key: TranscriptKeyEvent,
  options: { overlayActive: boolean },
): TranscriptPageScrollDirection | undefined {
  if (options.overlayActive) return undefined;
  if (key.pageUp) return "up";
  if (key.pageDown) return "down";
  return undefined;
}

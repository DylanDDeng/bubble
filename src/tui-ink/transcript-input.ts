export type TranscriptPageScrollDirection = "up" | "down";

export function transcriptPageScrollDirection(
  key: { pageUp?: boolean; pageDown?: boolean },
  options: { overlayActive: boolean },
): TranscriptPageScrollDirection | undefined {
  if (options.overlayActive) return undefined;
  if (key.pageUp) return "up";
  if (key.pageDown) return "down";
  return undefined;
}

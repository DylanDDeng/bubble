export interface InkKeyEvent {
  eventType?: string;
}

/**
 * Kitty keyboard protocol can report key press/repeat/release separately.
 * Release events still carry the printable text, so handling them like normal
 * input inserts every typed character twice.
 */
export function isKeyReleaseEvent(key: InkKeyEvent): boolean {
  return key.eventType === "release";
}

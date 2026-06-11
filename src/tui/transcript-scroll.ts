/**
 * Transcript scroll-follow policy.
 *
 * The transcript snaps to the bottom ("follows") while the user is at the
 * bottom, and stays put while they read older history. Two events override a
 * scrolled-up position and re-engage following:
 *   - the user sends a message (explicit intent to watch the newest turn)
 *   - an approval prompt appears (requires the user's attention)
 *
 * Those renders set `forcePending`, which must survive until the deferred
 * scroll actually runs: streaming redraws in the interim recompute the follow
 * flag from the (still unscrolled) position and would otherwise cancel the
 * snap. A user mouse scroll clears the pending force — their latest gesture
 * always wins.
 */

export interface TranscriptScrollState {
  /** A forceFollow render is waiting for its deferred scroll to execute. */
  forcePending: boolean;
  /** The viewport was at the bottom when the update was scheduled. */
  shouldFollow: boolean;
  /** Live follow flag, recomputed from the viewport position on each render. */
  following: boolean;
}

export type TranscriptScrollAction = "scroll-bottom" | "sync-position";

export function resolveTranscriptScroll(state: TranscriptScrollState): TranscriptScrollAction {
  if (state.forcePending) return "scroll-bottom";
  return state.shouldFollow && state.following ? "scroll-bottom" : "sync-position";
}

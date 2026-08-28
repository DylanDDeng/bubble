/**
 * Whether we're running inside a terminal multiplexer (tmux or GNU screen).
 *
 * Ink commits settled transcript rows to native scrollback via <Static> and
 * repaints only the short live region in place. When that live region SHRINKS
 * (a turn settles, a steer commits, a run is interrupted), Ink erases the prior
 * frame with a cursor-up + clear. Under a multiplexer that erase cannot reach
 * rows that have already scrolled out of the pane, leaving a blank gap — so
 * those transitions fall back to a full screen+scrollback reprint to stay clean.
 *
 * On a normal terminal that reprint is unnecessary (Ink's in-place erase works)
 * and visible as a one-frame full-screen flash, so we skip it. This predicate is
 * the gate. Pure + injectable for tests.
 */
export function isMultiplexedTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TMUX) return true; // inside tmux
  if (env.STY) return true; // inside GNU screen
  const term = env.TERM ?? "";
  return /^(screen|tmux)(-|\.|$)/.test(term); // e.g. screen-256color, tmux-256color
}

/**
 * Terminal multiplexer detection for the controller's terminal probe.
 * Reuses the legacy detection semantics (tmux/screen force full reprints).
 */
export function isMultiplexedTerminalLike(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TMUX) return true;
  const term = env.TERM ?? "";
  if (term.startsWith("screen") || term.startsWith("tmux")) return true;
  if (env.STY) return true;
  return false;
}

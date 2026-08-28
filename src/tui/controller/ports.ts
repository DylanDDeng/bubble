/**
 * Environment ports for the Bubble TUI controller.
 *
 * Every side effect the controller can trigger is expressed here as an
 * interface so tests can substitute deterministic fakes (spy host) and the
 * production host (Ink adapter today, pi-tui application later) can wire
 * real implementations. The controller layer never imports ink/react/pi-tui.
 */

/** Debounced streaming flush (40ms) shared semantics with the legacy TUI. */
export interface FlushScheduler {
  /** Schedule `flush` after `intervalMs`, merging with any pending flush. */
  scheduleFlush(intervalMs: number, flush: () => void): void;
  /** Drop any pending flush (must run before clearing stream state). */
  cancelFlush(): void;
}

export interface Clock {
  now(): number;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): Disposable;
  setInterval(callback: () => void, ms: number): Disposable;
}

/** Terminal multiplexer detection (tmux/screen need full reprints). */
export interface TerminalProbe {
  isMultiplexed(): boolean;
}

/**
 * Session storage boundary. The host (main.ts switchSession closure today)
 * owns the disk IO and failure semantics; the controller only commits UI
 * state after a successful prepare.
 */
export interface SessionHostPort {
  switchSession(file: string): { manager: import("../../session.js").SessionManager } | { error: string };
  createFresh(cwd: string): { manager: import("../../session.js").SessionManager } | { error: string };
}

export interface GitBranchProbe {
  /** Current git branch for the footer, or undefined outside a repo. */
  currentBranch(cwd: string): string | undefined;
}

export interface BubbleTuiPorts {
  clock: Clock;
  scheduler: Scheduler;
  flush: FlushScheduler;
  terminal: TerminalProbe;
  sessionHost: SessionHostPort;
  git: GitBranchProbe;
  /** Best-effort process exit; host decides signal semantics. */
  exitProcess(code: number): void;
}
